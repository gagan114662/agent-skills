import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ActivePlanDto,
  BillingInvoiceDto,
  BillingInvoicesResponseDto,
  BillingStatusDto,
  CheckoutResponseDto,
  PaymentLinkDto,
  PlanDto,
  PlansResponseDto,
  PricingExperimentReportDto,
  RevenueSummaryDto,
} from "@reload/shared";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { getAgentSession, type AgentSession } from "../db/repositories/agent-sessions.js";
import {
  BillingEgressBlocked,
  BillingProviderError,
  NoBillingConfigError,
  type BillingManager,
  type BillingInvoiceRecord,
  type PaymentLink,
  type RevenueSummary,
} from "../billing/manager.js";
import {
  UnknownPlanError,
  type ActivePlan,
  type PlanBillingService,
  type PlanListing,
  type PricingExperimentReport,
} from "../billing/plan-service.js";
import { isBillingInterval, type Plan } from "../billing/plans.js";
import { WebhookVerificationError } from "../billing/webhook.js";
import type { PriceInterval } from "../billing/provider.js";
import type { TrialNurtureService, TrialNurtureSignalKind } from "../billing/trial-nurture.js";
import { recordWebhookSignatureFailure } from "../observability/metrics.js";

export interface BillingRoutesOptions {
  billingManager: BillingManager;
  /** The #125 pricing/plan layer (catalog + workspace-scoped checkout). */
  planService: PlanBillingService;
  /** #607 free-trial in-product + email nurture and trial-to-paid measurement. */
  trialNurture: TrialNurtureService;
  /** #481 go-live snapshot (provider + declared mode + whether real money is on), surfaced read-only. */
  status: BillingStatusDto;
}

const MAX_NAME_LEN = 200;
const VALID_INTERVALS: readonly PriceInterval[] = ["day", "week", "month", "year"];
const MAX_RETURN_URL_LEN = 2048;

function isWebhookConfigError(err: WebhookVerificationError): boolean {
  return err.message.includes("no webhook secret configured");
}

/**
 * Validate a caller-supplied post-checkout redirect. Only well-formed `http(s)` URLs are honoured — this
 * keeps `javascript:`/`data:` and other schemes out of the hosted-link `after_completion` redirect. Returns
 * the normalised URL string, or `undefined` if absent/invalid (checkout then falls back to the provider's
 * own confirmation page). It is the customer's own app origin, so we don't allow-list hosts here.
 */
function safeReturnUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RETURN_URL_LEN)
    return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stripe revenue-rails routes (#98, ADR-0043). INBOUND money only:
 *   - `POST /channels/:cid/agent-sessions/:id/billing/payment-link` — mint a product+price+payment link
 *     for a session's deployed app (channel **write** + channel-scoped session → IDOR-safe), attach it to
 *     the deployment, post it to the channel.
 *   - `POST /billing/webhook/:wid` — the **unauthenticated but signature-verified** webhook receiver; it
 *     reads the **raw** body (a parser encapsulated to this one route) and persists a deduped revenue event.
 *   - `GET /workspaces/:wid/billing/revenue` — revenue-per-venture for the #71 usage dashboard.
 *
 * Outbound money (refunds/payouts/transfers) is NOT here — it is a #13 approval-gated, recorded-only
 * action (see `approvals/runtime.ts`); payouts stay manual in the Stripe dashboard.
 */
export async function billingRoutes(
  app: FastifyInstance,
  opts: BillingRoutesOptions,
): Promise<void> {
  const { billingManager, planService, trialNurture, status } = opts;

  async function authorize(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{
    workspaceId: string;
    memberId: string;
    cid: string;
    sessionId: string;
    session: AgentSession;
  } | null> {
    const id = await requireIdentity(req, reply);
    if (!id) return null;
    const { cid, id: sessionId } = req.params as { cid: string; id: string };
    if (!(await requireChannelCapability(id, cid, "write", reply))) return null;
    const session = await getAgentSession(sessionId, cid);
    if (!session) {
      reply.code(404).send({ error: "session not found" });
      return null;
    }
    return { workspaceId: id.workspaceId, memberId: id.memberId, cid, sessionId, session };
  }

  function toLinkDto(l: PaymentLink): PaymentLinkDto {
    return {
      id: l.id,
      sessionId: l.sessionId,
      channelId: l.channelId,
      deploymentId: l.deploymentId,
      provider: l.provider,
      url: l.url,
      amountCents: l.amountCents,
      currency: l.currency,
      interval: l.interval,
      createdAt: l.createdAt.toISOString(),
    };
  }

  function toSummaryDto(s: RevenueSummary): RevenueSummaryDto {
    return {
      currency: s.currency,
      totalCents: s.totalCents,
      paymentCount: s.paymentCount,
      evidenceCount: s.evidenceCount,
      recent: s.recent.map((e) => ({
        id: e.id,
        type: e.type,
        amountCents: e.amountCents,
        currency: e.currency,
        status: e.status,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  function toInvoiceDto(i: BillingInvoiceRecord): BillingInvoiceDto {
    return {
      id: i.id,
      providerEventId: i.providerEventId,
      providerInvoiceId: i.providerInvoiceId,
      number: i.number,
      hostedInvoiceUrl: i.hostedInvoiceUrl,
      invoicePdfUrl: i.invoicePdfUrl,
      status: i.status,
      amountCents: i.amountCents,
      currency: i.currency,
      createdAt: i.createdAt.toISOString(),
    };
  }

  function mapError(err: unknown, reply: FastifyReply): FastifyReply {
    if (err instanceof UnknownPlanError) {
      return reply.code(400).send({ error: "unknown plan" });
    }
    if (err instanceof NoBillingConfigError) {
      return reply.code(409).send({ error: "billing not enabled" });
    }
    if (err instanceof BillingEgressBlocked) {
      return reply.code(409).send({ error: "billing blocked by data-privacy mode" });
    }
    if (err instanceof BillingProviderError) {
      return reply.code(502).send({ error: "billing provider error", detail: err.message });
    }
    if (err instanceof Error && err.message.includes("assigned pricing experiment")) {
      return reply.code(409).send({ error: err.message });
    }
    if (err instanceof Error && err.message.includes("pricing experiment")) {
      return reply.code(400).send({ error: err.message });
    }
    throw err;
  }

  function toPlanDto(p: Plan): PlanDto {
    return {
      key: p.key,
      name: p.name,
      tagline: p.tagline,
      priceCents: p.priceCents,
      currency: p.currency,
      interval: p.interval,
      agentSeats: p.agentSeats,
      monthlySessionBudgetCents: p.monthlySessionBudgetCents,
      fleetSize: p.fleetSize,
      productLimits: { ...p.productLimits },
      dailyValue: p.dailyValue,
      dailyLimit: p.dailyLimit,
      upgradeTrigger: p.upgradeTrigger,
      highlights: [...p.highlights],
      featured: p.featured,
    };
  }

  function toActivePlanDto(a: ActivePlan): ActivePlanDto {
    return {
      planKey: a.planKey,
      status: a.status,
      agentSeats: a.agentSeats,
      monthlySessionBudgetCents: a.monthlySessionBudgetCents,
      fleetSize: a.fleetSize,
      activatedAt: a.activatedAt.toISOString(),
    };
  }

  function toListingDto(l: PlanListing): PlansResponseDto {
    return {
      plans: l.plans.map(toPlanDto),
      current: l.current ? toActivePlanDto(l.current) : null,
      pricingExperiment: l.pricingExperiment ?? null,
    };
  }

  function toPricingReportDto(r: PricingExperimentReport): PricingExperimentReportDto {
    return { ...r, variants: r.variants.map((v) => ({ ...v })) };
  }

  // Mint a payment link for the session's deployed app (inbound money).
  app.post("/channels/:cid/agent-sessions/:id/billing/payment-link", async (req, reply) => {
    const ctx = await authorize(req, reply);
    if (!ctx) return;
    const body = (req.body ?? {}) as {
      name?: unknown;
      amountCents?: unknown;
      currency?: unknown;
      interval?: unknown;
      billingEmail?: unknown;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_NAME_LEN) {
      return reply.code(400).send({ error: "name required (1..200 chars)" });
    }
    if (
      typeof body.amountCents !== "number" ||
      !Number.isInteger(body.amountCents) ||
      body.amountCents <= 0 ||
      body.amountCents > 100_000_000
    ) {
      return reply.code(400).send({ error: "amountCents must be a positive integer (cents)" });
    }
    const currency =
      typeof body.currency === "string" && /^[a-zA-Z]{3}$/.test(body.currency)
        ? body.currency.toLowerCase()
        : undefined;
    const interval =
      typeof body.interval === "string" && VALID_INTERVALS.includes(body.interval as PriceInterval)
        ? (body.interval as PriceInterval)
        : null;
    const billingEmail = typeof body.billingEmail === "string" ? body.billingEmail : undefined;

    try {
      const link = await billingManager.createPaymentLink({
        sessionId: ctx.sessionId,
        workspaceId: ctx.workspaceId,
        channelId: ctx.cid,
        agentMemberId: ctx.session.agentMemberId,
        createdByMemberId: ctx.memberId,
        name,
        amountCents: body.amountCents,
        currency,
        interval,
        billingEmail,
      });
      return reply.code(201).send(toLinkDto(link));
    } catch (err) {
      return mapError(err, reply);
    }
  });

  // The /pricing catalog + the workspace's active plan (#125). Un-gated: the page renders even before
  // billing is configured (`current` is null until a plan is activated).
  app.get("/workspaces/:wid/billing/plans", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const query = req.query as { visitorKey?: unknown };
    const visitorKey =
      typeof query.visitorKey === "string" && query.visitorKey ? query.visitorKey : id.memberId;
    const listing = await planService.listPlans(wid, { subjectKey: visitorKey });
    return reply.send(toListingDto(listing));
  });

  app.post("/workspaces/:wid/billing/pricing-experiments", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const body = (req.body ?? {}) as {
      name?: unknown;
      controlVariantKey?: unknown;
      minSampleSize?: unknown;
      variants?: unknown;
    };
    if (!Array.isArray(body.variants)) return reply.code(400).send({ error: "variants required" });
    try {
      const experiment = await planService.createPricingExperiment({
        workspaceId: wid,
        name: typeof body.name === "string" ? body.name : "Pricing experiment",
        controlVariantKey:
          typeof body.controlVariantKey === "string" ? body.controlVariantKey : undefined,
        minSampleSize:
          typeof body.minSampleSize === "number" && Number.isFinite(body.minSampleSize)
            ? Math.trunc(body.minSampleSize)
            : undefined,
        variants: body.variants as Array<{
          key: string;
          planKey: string;
          label?: string;
          weightBps?: number;
        }>,
      });
      return reply.code(201).send(experiment);
    } catch (err) {
      return mapError(err, reply);
    }
  });

  app.get("/workspaces/:wid/billing/pricing-experiments/:eid/report", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, eid } = req.params as { wid: string; eid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    try {
      return reply.send(toPricingReportDto(await planService.pricingExperimentReport(wid, eid)));
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        return reply.code(404).send({ error: "pricing experiment not found" });
      }
      return mapError(err, reply);
    }
  });

  // #481 go-live: the configured backend + declared mode so the UI shows the REAL state ("Live" vs "Test
  // mode") instead of a hardcoded banner. Read-only, workspace-scoped, no secrets — `live` is true only
  // when the stripe backend runs in live mode.
  app.get("/workspaces/:wid/billing/status", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const dto: BillingStatusDto = {
      provider: status.provider,
      mode: status.mode,
      live: status.live,
    };
    return reply.send(dto);
  });

  app.get("/workspaces/:wid/billing/invoices", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const query = req.query as { limit?: unknown };
    const limit =
      typeof query.limit === "string" && /^\d+$/.test(query.limit)
        ? Math.max(1, Math.min(100, Number(query.limit)))
        : 20;
    const dto: BillingInvoicesResponseDto = {
      invoices: (await billingManager.invoices(wid, limit)).map(toInvoiceDto),
    };
    return reply.send(dto);
  });

  app.get("/workspaces/:wid/billing/invoices/:invoiceId", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, invoiceId } = req.params as { wid: string; invoiceId: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const invoice = await billingManager.invoice(wid, invoiceId);
    if (!invoice) return reply.code(404).send({ error: "invoice not found" });
    return reply.send(toInvoiceDto(invoice));
  });

  app.get("/workspaces/:wid/billing/trial-nurture", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return trialNurture.plan(wid, id.memberId);
  });

  app.post("/workspaces/:wid/billing/trial-nurture/signals", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const body = (req.body ?? {}) as { kind?: unknown; detail?: unknown };
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!["nudge_view", "email_draft", "first_value", "upgrade_click"].includes(kind)) {
      return reply.code(400).send({ error: "invalid trial nurture signal" });
    }
    return trialNurture.signal(
      wid,
      id.memberId,
      kind as Exclude<TrialNurtureSignalKind, "paid">,
      typeof body.detail === "object" && body.detail
        ? (body.detail as Record<string, unknown>)
        : {},
    );
  });

  app.get("/workspaces/:wid/billing/trial-nurture/summary", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return trialNurture.summary(wid);
  });

  // Plan click → a real Stripe Checkout / payment link via the #98 provider seam (#125). INBOUND money.
  // Gated identically to the payment-link route: 409 (opt-in / privacy), 400 (unknown plan), 502 (provider).
  app.post("/workspaces/:wid/billing/checkout", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const body = (req.body ?? {}) as {
      planKey?: unknown;
      returnUrl?: unknown;
      pricingAssignmentId?: unknown;
      billingEmail?: unknown;
      billingInterval?: unknown;
      trackingRef?: unknown;
    };
    const planKey = typeof body.planKey === "string" ? body.planKey : "";
    if (!planKey) return reply.code(400).send({ error: "planKey required" });
    // Optional post-payment redirect back into the app. Only http/https is honoured (no javascript:/data: etc).
    const returnUrl = safeReturnUrl(body.returnUrl);
    try {
      const out = await planService.createCheckout({
        workspaceId: wid,
        planKey,
        createdByMemberId: id.memberId,
        ...(returnUrl ? { returnUrl } : {}),
        ...(typeof body.billingEmail === "string" ? { billingEmail: body.billingEmail } : {}),
        ...(typeof body.trackingRef === "string" ? { trackingRef: body.trackingRef } : {}),
        billingInterval:
          typeof body.billingInterval === "string" && isBillingInterval(body.billingInterval)
            ? body.billingInterval
            : "month",
        pricingAssignmentId:
          typeof body.pricingAssignmentId === "string" && body.pricingAssignmentId
            ? body.pricingAssignmentId
            : undefined,
      });
      const dto: CheckoutResponseDto = {
        url: out.url,
        planKey: out.planKey,
        billingInterval: out.billingInterval,
        pricingAssignmentId:
          typeof body.pricingAssignmentId === "string" && body.pricingAssignmentId
            ? body.pricingAssignmentId
            : null,
      };
      return reply.code(201).send(dto);
    } catch (err) {
      return mapError(err, reply);
    }
  });

  app.post("/workspaces/:wid/billing/cancel", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const updated = await planService.cancel(wid);
    if (!updated) return reply.code(404).send({ error: "active plan not found" });
    return reply.send(toActivePlanDto(updated));
  });

  app.post("/workspaces/:wid/billing/downgrade", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const body = (req.body ?? {}) as { planKey?: unknown };
    const planKey = typeof body.planKey === "string" ? body.planKey : "";
    if (!planKey) return reply.code(400).send({ error: "planKey required" });
    try {
      const updated = await planService.downgrade(wid, planKey);
      if (!updated) return reply.code(404).send({ error: "active plan not found" });
      return reply.send(toActivePlanDto(updated));
    } catch (err) {
      return mapError(err, reply);
    }
  });

  // Revenue-per-venture summary for the usage dashboard (#71).
  app.get("/workspaces/:wid/billing/revenue", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const summary = await billingManager.revenue(wid);
    return toSummaryDto(summary);
  });

  // The signature-verified webhook receiver. Encapsulated in its own plugin scope so the RAW body
  // (required for signature verification) is parsed as a Buffer ONLY for this route — the rest of the
  // app keeps normal JSON parsing (Fastify per-plugin content-type parsers).
  await app.register(async (webhookScope) => {
    webhookScope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );
    webhookScope.post("/billing/webhook/:wid", async (req, reply) => {
      const { wid } = req.params as { wid: string };
      const signature = req.headers["stripe-signature"];
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : String(req.body ?? "");
      try {
        const result = await billingManager.ingestWebhook(
          wid,
          rawBody,
          typeof signature === "string" ? signature : undefined,
        );
        return reply.code(200).send({ received: true, deduped: result.deduped });
      } catch (err) {
        if (err instanceof WebhookVerificationError) {
          if (isWebhookConfigError(err)) {
            req.log.error(
              { workspaceId: wid, err },
              "billing webhook is not configured; asking provider to retry",
            );
            return reply.code(503).send({ error: "webhook not configured" });
          }
          req.log.warn(
            { provider: "stripe", workspaceId: wid, reason: err.message },
            "webhook signature verification failed",
          );
          recordWebhookSignatureFailure("stripe", err.message);
          return reply.code(400).send({ error: "invalid signature" });
        }
        throw err;
      }
    });
  });
}
