import type { ResolvedConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { egressAllowed } from "../config/egress.js";
import type { SecretsResolver } from "../runtime/secrets-resolver.js";
import { makeRedactor } from "../runtime/redact.js";
import type { ChannelPoster, SessionLogger } from "../runtime/manager.js";
import { publishBillingEvent } from "../realtime/bus.js";
import type { BillingStatusEvent } from "../realtime/protocol.js";
import type { BillingProvider, PriceInterval } from "./provider.js";
import { verifyWebhookSignature } from "./webhook.js";

/**
 * BillingManager (#98, ADR-0043) — turns a session's deployed app into a revenue rail through a swappable
 * {@link BillingProvider}. It is **separate** from the `SessionManager` (a billing flow is a durable,
 * off-platform, credential-bearing job whose record must survive a restart — the #73 argument), persists
 * to dedicated tables, and reuses the proven secrets + redaction + egress + channel-post primitives.
 *
 * INBOUND ONLY: the manager has exactly two money operations — create a payment link and record an
 * inbound webhook. It can never move money out (the {@link BillingProvider} seam has no such method, and
 * outbound money is a #13 approval-gated, recorded-only action). Every provider error and the stored
 * webhook payload are passed through the per-tenant secret redactor before anything is persisted/published.
 */

export const DEFAULT_SECRET_KEY_NAME = "STRIPE_SECRET_KEY";
export const DEFAULT_WEBHOOK_SECRET_NAME = "STRIPE_WEBHOOK_SECRET";
export const DEFAULT_CURRENCY = "usd";

/** Webhook event types that represent a real, completed inbound payment (→ willingness-to-pay evidence). */
const PAYMENT_EVENT_TYPES: readonly string[] = [
  "checkout.session.completed",
  "payment_intent.succeeded",
  "charge.succeeded",
  "invoice.paid",
  "invoice.payment_succeeded",
];

// --- row + input types (the repository implements the store seam over these) --------------------------

export interface CreatePaymentLinkRow {
  workspaceId: string;
  channelId: string;
  sessionId: string;
  deploymentId: string | null;
  provider: string;
  productId: string;
  priceId: string;
  providerLinkId: string;
  url: string;
  amountCents: number;
  currency: string;
  interval: string | null;
  createdByMemberId: string | null;
}
export interface PaymentLink extends CreatePaymentLinkRow {
  id: string;
  createdAt: Date;
}

export interface CreateRevenueEventRow {
  workspaceId: string;
  channelId: string | null;
  sessionId: string | null;
  deploymentId: string | null;
  provider: string;
  providerEventId: string;
  type: string;
  amountCents: number;
  currency: string;
  status: string;
  /** The REDACTED webhook payload (stored verbatim as a JSON string value). */
  raw: string;
}
export interface RevenueEvent extends CreateRevenueEventRow {
  id: string;
  createdAt: Date;
}

export interface CreateEvidenceRow {
  workspaceId: string;
  sessionId: string | null;
  kind: string;
  source: string;
  revenueEventId: string | null;
  amountCents: number;
  currency: string;
  summary: string;
}
export interface RevenueEvidence extends CreateEvidenceRow {
  id: string;
  createdAt: Date;
}

export interface RevenueSummary {
  currency: string;
  totalCents: number;
  paymentCount: number;
  evidenceCount: number;
  recent: RevenueEvent[];
}

/** The injectable persistence seam (the DB repo in prod; an in-memory store in unit tests). */
export interface BillingStore {
  createPaymentLink(input: CreatePaymentLinkRow): Promise<PaymentLink>;
  findRevenueEvent(workspaceId: string, providerEventId: string): Promise<RevenueEvent | undefined>;
  createRevenueEvent(input: CreateRevenueEventRow): Promise<RevenueEvent>;
  createEvidence(input: CreateEvidenceRow): Promise<RevenueEvidence>;
  revenueSummary(workspaceId: string, limit?: number): Promise<RevenueSummary>;
}

/** The narrow deployment lookup the manager needs to attach a link to a session's deployment record. */
export interface DeploymentLookup {
  latestForSession(sessionId: string, channelId: string): Promise<{ id: string } | undefined>;
}

// --- typed errors (mapped to HTTP by the route) ------------------------------------------------------

/** Thrown when the tenant hasn't enabled billing (no `billing` config section) → route 409. */
export class NoBillingConfigError extends Error {
  constructor() {
    super("no billing configuration");
    this.name = "NoBillingConfigError";
  }
}

/** Thrown when data-privacy mode forbids the off-platform egress a Stripe call requires → route 409. */
export class BillingEgressBlocked extends Error {
  constructor() {
    super("billing blocked by data-privacy mode");
    this.name = "BillingEgressBlocked";
  }
}

/** Wraps a provider failure with the secret values already redacted out → route 502. */
export class BillingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingProviderError";
  }
}

export interface CreatePaymentLinkRequest {
  sessionId: string;
  workspaceId: string;
  channelId: string;
  /** The session's agent member — the payment-link announcement is posted as it. */
  agentMemberId: string;
  /** The human who created the link (audit). */
  createdByMemberId: string;
  name: string;
  amountCents: number;
  currency?: string;
  interval?: PriceInterval | null;
}

export interface WebhookIngestResult {
  deduped: boolean;
  event?: RevenueEvent;
}

/**
 * The plan-activation seam (#125): when a deduped payment webhook carries `metadata.kind =
 * "plan_checkout"`, the manager calls this to mark the workspace's plan + update its caps. Declared here
 * (rather than importing `PlanBillingService`) so the #125 layer depends on #98, never the reverse.
 */
export interface PlanActivator {
  activate(workspaceId: string, planKey: string, providerEventId: string): Promise<unknown>;
}

/**
 * The demand-signal seam (#101): when a deduped payment webhook carries `metadata.kind = "demand_smoke"`,
 * the manager hands the charge to the Demand Validation Rails as the apex external `paid` signal (and the
 * ethics auto-refund fires there). Declared here (rather than importing the demand service) so #101
 * depends on #98, never the reverse — the same one-way dependency as the #125 {@link PlanActivator}.
 */
export interface DemandSignalIngestor {
  ingestCheckout(input: {
    workspaceId: string;
    experimentId: string;
    externalRef: string;
    amountCents: number;
    currency: string;
  }): Promise<unknown>;
}

export interface BillingManagerDeps {
  provider: BillingProvider;
  store: BillingStore;
  poster: ChannelPoster;
  secrets: SecretsResolver;
  deployments: DeploymentLookup;
  /** Optional #125 plan activation: invoked for a `plan_checkout` payment event (best-effort). */
  planActivator?: PlanActivator;
  /** Optional #101 demand ingest: invoked for a `demand_smoke` payment event (best-effort). */
  demandIngestor?: DemandSignalIngestor;
  loadConfig?: (workspaceId: string) => ResolvedConfig;
  publish?: (channelId: string, event: BillingStatusEvent) => void;
  logger?: SessionLogger;
  now?: () => Date;
  toleranceSec?: number;
}

export class BillingManager {
  private readonly provider: BillingProvider;
  private readonly store: BillingStore;
  private readonly poster: ChannelPoster;
  private readonly secrets: SecretsResolver;
  private readonly deployments: DeploymentLookup;
  private readonly planActivator?: PlanActivator;
  private readonly demandIngestor?: DemandSignalIngestor;
  private readonly load: (workspaceId: string) => ResolvedConfig;
  private readonly publish: (channelId: string, event: BillingStatusEvent) => void;
  private readonly logger?: SessionLogger;
  private readonly now: () => Date;
  private readonly toleranceSec: number;

  constructor(deps: BillingManagerDeps) {
    this.provider = deps.provider;
    this.store = deps.store;
    this.poster = deps.poster;
    this.secrets = deps.secrets;
    this.deployments = deps.deployments;
    this.planActivator = deps.planActivator;
    this.demandIngestor = deps.demandIngestor;
    this.load = deps.loadConfig ?? ((workspaceId) => loadConfig(workspaceId));
    this.publish =
      deps.publish ??
      ((channelId, event) => {
        publishBillingEvent(channelId, event).catch(() => {
          /* best-effort realtime; the DB row is the source of truth */
        });
      });
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
    this.toleranceSec = deps.toleranceSec ?? 300;
  }

  /**
   * Create a product + price + hosted payment link for a session's deployed app, attach it to the
   * session's latest deployment, and post the link into the channel. Throws on opt-out / privacy mode
   * (route → 409) and wraps a provider failure in a redacted {@link BillingProviderError} (route → 502).
   */
  async createPaymentLink(req: CreatePaymentLinkRequest): Promise<PaymentLink> {
    const cfg = this.gate(req.workspaceId);
    const secrets = await this.secrets.resolve(req.workspaceId);
    const redact = makeRedactor(secrets);
    const currency = (req.currency ?? cfg.billing?.currency ?? DEFAULT_CURRENCY).toLowerCase();
    const interval = req.interval ?? null;

    const latest = await this.deployments.latestForSession(req.sessionId, req.channelId);
    const deploymentId = latest?.id ?? null;

    let productId: string;
    let priceId: string;
    let providerLinkId: string;
    let url: string;
    try {
      const pp = await this.provider.createProductPrice({
        name: req.name,
        amountCents: req.amountCents,
        currency,
        interval,
        secrets,
      });
      const link = await this.provider.createPaymentLink({
        priceId: pp.priceId,
        slug: this.slug(req.sessionId),
        metadata: {
          workspaceId: req.workspaceId,
          channelId: req.channelId,
          sessionId: req.sessionId,
          // The agent member to post the "payment received" announcement AS, round-tripped via the
          // provider webhook so a later delivery can attribute the channel message.
          agentMemberId: req.agentMemberId,
          ...(deploymentId ? { deploymentId } : {}),
        },
        secrets,
      });
      productId = pp.productId;
      priceId = pp.priceId;
      providerLinkId = link.providerLinkId;
      url = link.url;
    } catch (err) {
      throw new BillingProviderError(redact(err instanceof Error ? err.message : String(err)));
    }

    const row = await this.store.createPaymentLink({
      workspaceId: req.workspaceId,
      channelId: req.channelId,
      sessionId: req.sessionId,
      deploymentId,
      provider: this.provider.kind,
      productId,
      priceId,
      providerLinkId,
      url,
      amountCents: req.amountCents,
      currency,
      interval,
      createdByMemberId: req.createdByMemberId,
    });

    this.publish(req.channelId, {
      type: "billing_status",
      kind: "link_created",
      channelId: req.channelId,
      sessionId: req.sessionId,
      url,
      amountCents: req.amountCents,
      currency,
    });
    await this.post(
      req.workspaceId,
      req.channelId,
      req.agentMemberId,
      `💳 Pay here: ${url} (${formatAmount(req.amountCents, currency)}${interval ? `/${interval}` : ""})`,
    );
    return row;
  }

  /**
   * Ingest a provider webhook: verify the signature over the raw body (throws on a forged/replayed
   * delivery → route 400), dedupe on `(workspace, provider event id)`, persist a redacted
   * `revenue_events` row, and — for a real payment — record willingness-to-pay evidence + post to the
   * originating channel. Idempotent: a replayed event id returns the existing row, no new writes.
   */
  async ingestWebhook(
    workspaceId: string,
    rawBody: string,
    signature: string | undefined,
  ): Promise<WebhookIngestResult> {
    const cfg = this.tryLoad(workspaceId);
    const secrets = await this.secrets.resolve(workspaceId);
    const webhookSecretName = cfg?.billing?.webhookSecretName ?? DEFAULT_WEBHOOK_SECRET_NAME;
    verifyWebhookSignature(rawBody, signature, secrets[webhookSecretName] ?? "", {
      now: this.now(),
      toleranceSec: this.toleranceSec,
    });

    const parsed = parseEvent(rawBody, cfg?.billing?.currency ?? DEFAULT_CURRENCY);

    const existing = await this.store.findRevenueEvent(workspaceId, parsed.id);
    if (existing) return { deduped: true, event: existing };

    const redact = makeRedactor(secrets);
    const event = await this.store.createRevenueEvent({
      workspaceId,
      channelId: parsed.metadata.channelId ?? null,
      sessionId: parsed.metadata.sessionId ?? null,
      deploymentId: parsed.metadata.deploymentId ?? null,
      provider: this.provider.kind,
      providerEventId: parsed.id,
      type: parsed.type,
      amountCents: parsed.amountCents,
      currency: parsed.currency,
      status: parsed.status,
      raw: redact(rawBody),
    });

    if (isPaymentEvent(parsed.type)) {
      await this.store.createEvidence({
        workspaceId,
        sessionId: parsed.metadata.sessionId ?? null,
        kind: "willingness_to_pay",
        source: "revenue",
        revenueEventId: event.id,
        amountCents: parsed.amountCents,
        currency: parsed.currency,
        summary: `Real payment of ${formatAmount(parsed.amountCents, parsed.currency)} (${parsed.type})`,
      });
      if (parsed.metadata.channelId && parsed.metadata.agentMemberId) {
        await this.post(
          workspaceId,
          parsed.metadata.channelId,
          parsed.metadata.agentMemberId,
          `💰 Received ${formatAmount(parsed.amountCents, parsed.currency)}`,
        );
      } else if (parsed.metadata.channelId) {
        // No agent member in metadata: still nudge the channel via the realtime event (no message author).
        this.logger?.info(
          { workspaceId, amountCents: parsed.amountCents },
          "billing: payment received (no agent member to post as)",
        );
      }
      if (parsed.metadata.channelId) {
        this.publish(parsed.metadata.channelId, {
          type: "billing_status",
          kind: "payment_received",
          channelId: parsed.metadata.channelId,
          sessionId: parsed.metadata.sessionId ?? null,
          amountCents: parsed.amountCents,
          currency: parsed.currency,
        });
      }
      // #125: a plan checkout payment activates the workspace's plan + updates its caps. Best-effort —
      // the revenue row is already the source of truth, and dedupe above makes this exactly-once.
      if (parsed.metadata.kind === "plan_checkout" && parsed.metadata.planKey && this.planActivator) {
        try {
          await this.planActivator.activate(workspaceId, parsed.metadata.planKey, parsed.id);
        } catch (err) {
          this.logger?.warn({ workspaceId, err }, "billing: plan activation failed");
        }
      }
      // #101: a demand smoke-test checkout is the apex external willingness-to-pay signal. Hand it to the
      // Demand Validation Rails (which records the `paid` signal + fires the ethics auto-refund). Best-
      // effort + exactly-once (the revenue dedupe above guarantees one delivery reaches here).
      if (parsed.metadata.kind === "demand_smoke" && parsed.metadata.experimentId && this.demandIngestor) {
        try {
          await this.demandIngestor.ingestCheckout({
            workspaceId,
            experimentId: parsed.metadata.experimentId,
            externalRef: parsed.id,
            amountCents: parsed.amountCents,
            currency: parsed.currency,
          });
        } catch (err) {
          this.logger?.warn({ workspaceId, err }, "billing: demand signal ingest failed");
        }
      }
    }

    return { deduped: false, event };
  }

  /** Revenue summary for a workspace (the #71 dashboard surface): totals + recent events + evidence count. */
  revenue(workspaceId: string, limit = 10): Promise<RevenueSummary> {
    return this.store.revenueSummary(workspaceId, limit);
  }

  // --- internals ---

  /** Enforce the opt-in + egress invariants for an outbound Stripe call. Returns the resolved config. */
  private gate(workspaceId: string): ResolvedConfig {
    const cfg = this.load(workspaceId);
    if (!cfg.billing) throw new NoBillingConfigError();
    if (!egressAllowed(cfg)) throw new BillingEgressBlocked();
    return cfg;
  }

  /** Load config without throwing (the webhook path tolerates a tenant with no billing section). */
  private tryLoad(workspaceId: string): ResolvedConfig | undefined {
    try {
      return this.load(workspaceId);
    } catch {
      return undefined;
    }
  }

  private slug(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  }

  private async post(
    workspaceId: string,
    channelId: string,
    agentMemberId: string,
    body: string,
  ): Promise<void> {
    try {
      await this.poster.post({ workspaceId, channelId, agentMemberId, body });
    } catch (err) {
      this.logger?.warn({ channelId, err }, "billing channel post failed");
    }
  }
}

// --- pure helpers ------------------------------------------------------------------------------------

interface ParsedEvent {
  id: string;
  type: string;
  amountCents: number;
  currency: string;
  status: string;
  metadata: Record<string, string>;
}

/** Whether a webhook event type represents a completed inbound payment. */
export function isPaymentEvent(type: string): boolean {
  return PAYMENT_EVENT_TYPES.includes(type);
}

/**
 * Tolerantly parse a provider webhook body into the fields we persist. Stripe nests the resource under
 * `data.object`; amount may be `amount_total` (checkout), `amount` (charge), or `amount_received`
 * (payment intent). Unknown/missing fields degrade to safe defaults — a malformed-but-signed body still
 * yields a recordable event rather than throwing after verification.
 */
function parseEvent(rawBody: string, defaultCurrency: string): ParsedEvent {
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    /* keep defaults */
  }
  const data = (obj.data as Record<string, unknown> | undefined)?.object as
    | Record<string, unknown>
    | undefined;
  const amount =
    num(data?.amount_total) ?? num(data?.amount) ?? num(data?.amount_received) ?? 0;
  const metadataRaw = (data?.metadata as Record<string, unknown> | undefined) ?? {};
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadataRaw)) {
    if (typeof v === "string") metadata[k] = v;
  }
  return {
    id: typeof obj.id === "string" && obj.id ? obj.id : "evt_unknown",
    type: typeof obj.type === "string" ? obj.type : "unknown",
    amountCents: amount,
    currency: (typeof data?.currency === "string" ? data.currency : defaultCurrency).toLowerCase(),
    status:
      (typeof data?.payment_status === "string" && data.payment_status) ||
      (typeof data?.status === "string" && data.status) ||
      "succeeded",
    metadata,
  };
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Format cents as a human amount (e.g. 2500 + usd → "$25.00"). Falls back to "<amount> <CUR>". */
function formatAmount(amountCents: number, currency: string): string {
  const major = (amountCents / 100).toFixed(2);
  const symbol = currency.toLowerCase() === "usd" ? "$" : "";
  return symbol ? `${symbol}${major}` : `${major} ${currency.toUpperCase()}`;
}
