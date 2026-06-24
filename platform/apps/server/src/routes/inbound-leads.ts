import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertWorkspace, requireIdentity } from "../auth/guard.js";
import type { DiscoveryService } from "../discovery/service.js";
import {
  getLead,
  findRecentLeadDuplicate,
  listLeads,
  markSlaNotified,
  recordLead,
  updateLead,
  verifyLeadByTokenHash,
} from "../db/repositories/inbound-leads.js";
import { getWorkspaceOwnerMemberId } from "../db/repositories/members.js";
import { INBOUND_LEAD_STATUSES, type InboundLeadStatus } from "../db/schema/index.js";
import { sanitizeLead, toDiscoverySignal } from "../leads/inbound.js";
import {
  INBOUND_LEAD_PUBLIC_RATE_LIMIT,
  publicRateLimitPreHandler,
} from "../http/rate-limit.js";
import type { InboundLeadFollowup } from "../leads/default.js";
import { notify } from "../notifications/service.js";
import {
  recordAsyncSideEffectFailure,
  recordInboundLeadRejection,
} from "../observability/metrics.js";

/**
 * Inbound lead capture route (GAP 1 of the leads centre, ADR-0400). ONE PUBLIC (unauth) endpoint,
 * `POST /inbound/leads`, mirroring the public-hook style of `routes/support.ts` / the acquisition
 * unsubscribe receiver. Submission is public, but email confirmation links are HMAC-signed so a lead is not
 * treated as verified until the address holder clicks the link.
 * It is the autonomous loop's inbound mouth: the public landing "what are you hoping the fleet can do?"
 * form posts here so a real prospect persists (instead of being dropped client-side) and best-effort
 * becomes a #222 discovery signal the fleet can work.
 *
 * SAFETY: no money, no new #13 action — capturing an unverified lead is the safe + necessary default, and
 * only the confirmation email is sent before verification. The body is UNTRUSTED inbound DATA (#200 §6):
 * every field is sanitized + length-capped + shape-validated in `leads/inbound.ts` before anything is
 * persisted, and the workspace is NEVER taken from the body except as an explicit allow-listed override.
 * The discovery feed is BEST-EFFORT after verification — a discovery hiccup must never fail the lead capture.
 */
export interface InboundLeadsRoutesOptions {
  discovery: DiscoveryService;
  /** Best-effort warm-lead automation: import into Reach and run the opener/cadence loop. */
  warmLeadFollowup?: InboundLeadFollowup;
  /**
   * The workspace a public landing lead belongs to (the marketing-owner workspace). When unset, the public
   * form is not wired to a workspace and the route 503s — but a `workspaceId` in the body is still honored
   * if it matches this owner (so a dev/staging deploy without the env var can opt a single workspace in).
   */
  ownerWorkspaceId?: string;
  /**
   * Confirmation sender for public email verification (#929). App wiring uses the existing ESP seam
   * (dry-run by default, live only when a deployment deliberately supplies a live sender).
   */
  confirmation?: {
    secret?: string;
    baseUrl?: string;
    send(input: {
      to: string;
      name: string | null;
      confirmationUrl: string;
    }): Promise<void>;
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INBOUND_LEAD_NEXT_STEP = {
  label: "Start a free trial now",
  href: "/start?source=inbound_lead",
} as const;
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONFIRMATION_SECRET =
  process.env.INBOUND_LEAD_CONFIRMATION_SECRET ??
  (process.env.NODE_ENV === "production" ? undefined : "dev-inbound-lead-confirmation");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function confirmationSignature(input: {
  leadId: string;
  email: string;
  token: string;
  secret: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(`${input.leadId}\n${input.email}\n${input.token}`, "utf8")
    .digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function confirmationBaseUrl(req: FastifyRequest, configured: string | undefined): string {
  if (configured?.trim()) return configured.trim().replace(/\/$/, "");
  const host = req.headers.host ?? "localhost";
  const proto = host.includes("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  return `${proto}://${host}`;
}

function validConfirmationQuery(query: unknown, secret: string): { ok: true; tokenHash: string } | { ok: false } {
  const q = (query ?? {}) as Record<string, unknown>;
  const id = typeof q.id === "string" ? q.id : "";
  const email = typeof q.email === "string" ? q.email.trim().toLowerCase() : "";
  const token = typeof q.token === "string" ? q.token : "";
  const sig = typeof q.sig === "string" ? q.sig : "";
  if (!id || !email || !token || !sig) return { ok: false };
  const expected = confirmationSignature({ leadId: id, email, token, secret });
  if (!safeEqual(expected, sig)) return { ok: false };
  return { ok: true, tokenHash: sha256(token) };
}

function leadStatus(value: unknown): InboundLeadStatus | undefined {
  return typeof value === "string" && (INBOUND_LEAD_STATUSES as readonly string[]).includes(value)
    ? (value as InboundLeadStatus)
    : undefined;
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || null;
}

function leadExcerpt(
  kind: "arrived" | "sla",
  lead: { name: string | null; email: string; message: string },
): string {
  const who = lead.name ? `${lead.name} <${lead.email}>` : lead.email;
  const shortMessage =
    lead.message.length > 140 ? `${lead.message.slice(0, 137)}...` : lead.message;
  return kind === "arrived"
    ? `New inbound lead from ${who}: ${shortMessage}`
    : `24h SLA breached for inbound lead ${who}: ${shortMessage}`;
}

function leadRejectionContext(body: Record<string, unknown>): { email: string; source: string } {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 160) : "";
  const source = typeof body.source === "string" ? body.source.trim().slice(0, 80) : "unknown";
  return { email, source: source || "unknown" };
}

function listQuery(query: unknown): {
  status?: InboundLeadStatus;
  sinceMs?: number;
  limit?: number;
} {
  const q = (query ?? {}) as { status?: unknown; sinceMs?: unknown; limit?: unknown };
  const sinceMs = typeof q.sinceMs === "string" ? Number.parseInt(q.sinceMs, 10) : undefined;
  const limit = typeof q.limit === "string" ? Number.parseInt(q.limit, 10) : undefined;
  return {
    status: leadStatus(q.status),
    sinceMs: Number.isFinite(sinceMs) ? sinceMs : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  };
}

function csvField(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function leadsCsv(leads: Awaited<ReturnType<typeof listLeads>>): string {
  const header = [
    "id",
    "email",
    "name",
    "message",
    "source",
    "trackingRef",
    "status",
    "assigneeMemberId",
    "nextAction",
    "createdAtMs",
    "respondedAtMs",
    "slaDueAtMs",
  ];
  const rows = leads.map((lead) =>
    [
      lead.id,
      lead.email,
      lead.name,
      lead.message,
      lead.source,
      lead.trackingRef,
      lead.status,
      lead.assigneeMemberId,
      lead.nextAction,
      lead.createdAtMs,
      lead.respondedAtMs,
      lead.slaDueAtMs,
    ]
      .map(csvField)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}

function rejectInboundLead(
  req: FastifyRequest,
  reply: FastifyReply,
  code: 400 | 503,
  reason: string,
  error: string,
  body: Record<string, unknown>,
) {
  recordInboundLeadRejection(reason);
  req.log.warn({ reason, ...leadRejectionContext(body) }, "inbound lead rejected");
  return reply.code(code).send({ error });
}

async function notifyOwner(
  app: FastifyInstance,
  workspaceId: string,
  excerpt: string,
): Promise<void> {
  const ownerMemberId = await getWorkspaceOwnerMemberId(workspaceId);
  if (!ownerMemberId) return;
  await notify(app.log, {
    workspaceId,
    recipientMemberId: ownerMemberId,
    type: "inbound_lead",
    excerpt,
  });
}

export async function inboundLeadsRoutes(
  app: FastifyInstance,
  opts: InboundLeadsRoutesOptions,
): Promise<void> {
  const { discovery, ownerWorkspaceId, warmLeadFollowup } = opts;
  const inboundLeadRateLimit = publicRateLimitPreHandler(INBOUND_LEAD_PUBLIC_RATE_LIMIT);
  const confirmationSecret = opts.confirmation?.secret ?? DEFAULT_CONFIRMATION_SECRET;

  async function activateVerifiedLead(
    req: FastifyRequest,
    workspaceId: string,
    id: string,
    lead: { name: string | null; email: string; message: string; source: string; trackingRef: string | null },
  ): Promise<void> {
    try {
      await notifyOwner(app, workspaceId, leadExcerpt("arrived", lead));
    } catch (err) {
      recordAsyncSideEffectFailure("inbound_lead_owner_notification");
      req.log.error(
        { err, workspaceId, leadId: id },
        "inbound lead owner notification failed after verified lead write",
      );
    }

    try {
      const prospectKeyHash = createHash("sha256").update(lead.email).digest("hex").slice(0, 32);
      const signal = toDiscoverySignal(lead, prospectKeyHash);
      await discovery.defineSignal(workspaceId, {
        kind: "role_match",
        label: "inbound_lead_default",
        role: "inbound_lead",
        threshold: 1,
        windowDays: 30,
        weight: 100,
        enabled: true,
      });
      await discovery.ingestSignal(workspaceId, {
        prospectKey: signal.prospectKey,
        kind: signal.kind,
        role: signal.role,
        source: signal.source,
        detail: signal.detail,
      });
    } catch (err) {
      recordAsyncSideEffectFailure("inbound_lead_discovery_ingest");
      req.log.error(
        { err, workspaceId, leadId: id },
        "inbound lead discovery ingest failed after verified lead write",
      );
    }

    try {
      await warmLeadFollowup?.handle({ workspaceId, leadId: id, lead });
    } catch (err) {
      recordAsyncSideEffectFailure("inbound_lead_warm_followup");
      req.log.error(
        { err, workspaceId, leadId: id },
        "inbound lead warm follow-up failed after verified lead write",
      );
    }
  }

  app.get("/me/inbound/leads", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const leads = await listLeads(id.workspaceId, listQuery(req.query));
    for (const lead of leads) {
      if (!lead.slaBreached || lead.slaNotifiedAtMs !== null) continue;
      await notifyOwner(app, id.workspaceId, leadExcerpt("sla", lead));
      await markSlaNotified(id.workspaceId, lead.id);
    }
    return { leads };
  });

  app.get("/workspaces/:wid/leads", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const leads = await listLeads(wid, listQuery(req.query));
    return { leads };
  });

  app.get("/workspaces/:wid/leads/export.csv", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const leads = await listLeads(wid, listQuery(req.query));
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="inbound-leads.csv"');
    return reply.send(leadsCsv(leads));
  });

  app.get("/me/inbound/leads/:leadId", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { leadId } = req.params as { leadId: string };
    const lead = await getLead(id.workspaceId, leadId);
    if (!lead) return reply.code(404).send({ error: "lead not found" });
    return { lead };
  });

  app.patch("/me/inbound/leads/:leadId", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { leadId } = req.params as { leadId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = body.status === undefined ? undefined : leadStatus(body.status);
    if (body.status !== undefined && !status)
      return reply.code(400).send({ error: "invalid lead status" });
    const assigneeMemberId =
      body.assigneeMemberId === undefined ? undefined : nullableText(body.assigneeMemberId);
    if (assigneeMemberId && !UUID_RE.test(assigneeMemberId))
      return reply.code(400).send({ error: "invalid assigneeMemberId" });
    const nextAction = body.nextAction === undefined ? undefined : nullableText(body.nextAction);
    const respondedAt =
      body.respondedAt === undefined
        ? undefined
        : body.respondedAt === null
          ? null
          : typeof body.respondedAt === "string"
            ? new Date(body.respondedAt)
            : undefined;
    if (respondedAt instanceof Date && Number.isNaN(respondedAt.getTime())) {
      return reply.code(400).send({ error: "invalid respondedAt" });
    }
    const lead = await updateLead(id.workspaceId, leadId, {
      status,
      assigneeMemberId,
      nextAction,
      respondedAt,
    });
    if (!lead) return reply.code(404).send({ error: "lead not found" });
    return { lead };
  });

  app.post("/inbound/leads", { preHandler: inboundLeadRateLimit }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.companyWebsite === "string" && body.companyWebsite.trim().length > 0) {
      req.log.warn({ source: "honeypot" }, "inbound lead rejected by honeypot");
      return reply.code(202).send({ received: true, nextStep: INBOUND_LEAD_NEXT_STEP });
    }

    // Resolve the target workspace: the configured owner by default. A `workspaceId` in the body is only
    // honored when it EXACTLY matches the owner — the public form can never aim a lead at another tenant.
    const bodyWid = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    let workspaceId = ownerWorkspaceId ?? "";
    if (bodyWid) {
      if (!UUID_RE.test(bodyWid) || (ownerWorkspaceId && bodyWid !== ownerWorkspaceId)) {
        return rejectInboundLead(
          req,
          reply,
          400,
          "invalid_workspace",
          "workspaceId is not accepted",
          body,
        );
      }
      workspaceId = bodyWid;
    }
    if (!workspaceId) {
      return rejectInboundLead(
        req,
        reply,
        503,
        "not_configured",
        "inbound lead capture is not configured",
        body,
      );
    }

    const sanitized = sanitizeLead({
      name: body.name,
      email: body.email,
      message: body.message,
      source: body.source,
      trackingRef: body.trackingRef,
    });
    if (!sanitized.ok)
      return rejectInboundLead(req, reply, 400, "invalid_payload", sanitized.error, body);
    const lead = sanitized.lead;
    const emailHash = sha256(lead.email);
    const submitterHash = sha256(req.ip || "unknown");
    const duplicate = await findRecentLeadDuplicate({
      workspaceId,
      emailHash,
      submitterHash,
      since: new Date(Date.now() - DEDUPE_WINDOW_MS),
    });
    if (duplicate) {
      req.log.info({ workspaceId, leadId: duplicate.id }, "inbound lead duplicate suppressed");
      return reply.code(202).send({ received: true, nextStep: INBOUND_LEAD_NEXT_STEP });
    }
    if (!confirmationSecret) {
      return rejectInboundLead(
        req,
        reply,
        503,
        "confirmation_not_configured",
        "inbound lead confirmation is not configured",
        body,
      );
    }

    const confirmationToken = randomBytes(24).toString("hex");

    // Persist FIRST as unverified — external discovery/follow-up only happens after the email link is clicked.
    const created = await recordLead({
      workspaceId,
      name: lead.name,
      email: lead.email,
      emailHash,
      submitterHash,
      verificationTokenHash: sha256(confirmationToken),
      verificationSentAt: new Date(),
      message: lead.message,
      source: lead.source,
      trackingRef: lead.trackingRef,
    });
    const sig = confirmationSignature({
      leadId: created.id,
      email: lead.email,
      token: confirmationToken,
      secret: confirmationSecret,
    });
    const params = new URLSearchParams({ id: created.id, email: lead.email, token: confirmationToken, sig });
    const confirmationUrl =
      confirmationBaseUrl(req, opts.confirmation?.baseUrl) + "/inbound/leads/confirm?" + params.toString();

    try {
      await opts.confirmation?.send({ to: lead.email, name: lead.name, confirmationUrl });
    } catch (err) {
      recordAsyncSideEffectFailure("inbound_lead_confirmation_email");
      req.log.error(
        { err, workspaceId, leadId: created.id },
        "inbound lead confirmation email failed after durable lead write",
      );
    }

    return reply.code(202).send({ received: true, nextStep: INBOUND_LEAD_NEXT_STEP });
  });

  app.get("/inbound/leads/confirm", async (req, reply) => {
    if (!confirmationSecret) return reply.code(503).send({ error: "inbound lead confirmation is not configured" });
    const verified = validConfirmationQuery(req.query, confirmationSecret);
    if (!verified.ok) return reply.code(400).send({ error: "invalid confirmation link" });
    const lead = await verifyLeadByTokenHash(verified.tokenHash);
    if (!lead) return reply.code(400).send({ error: "invalid or expired confirmation link" });
    await activateVerifiedLead(req, lead.workspaceId, lead.id, {
      name: lead.name,
      email: lead.email,
      message: lead.message,
      source: lead.source,
      trackingRef: lead.trackingRef,
    });
    return { verified: true, nextStep: INBOUND_LEAD_NEXT_STEP };
  });

}
