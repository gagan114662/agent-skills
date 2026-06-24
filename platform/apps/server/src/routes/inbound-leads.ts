import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import type { DiscoveryService } from "../discovery/service.js";
import { getLead, listLeads, markSlaNotified, recordLead, updateLead } from "../db/repositories/inbound-leads.js";
import { getWorkspaceOwnerMemberId } from "../db/repositories/members.js";
import { INBOUND_LEAD_STATUSES, type InboundLeadStatus } from "../db/schema/index.js";
import { sanitizeLead, toDiscoverySignal } from "../leads/inbound.js";
import type { InboundLeadFollowup } from "../leads/default.js";
import { notify } from "../notifications/service.js";
import { recordAsyncSideEffectFailure } from "../observability/metrics.js";

/**
 * Inbound lead capture route (GAP 1 of the leads centre, ADR-0400). ONE PUBLIC (unauth) endpoint,
 * `POST /inbound/leads`, mirroring the public-hook style of `routes/support.ts` / the acquisition
 * unsubscribe receiver — but WITHOUT an HMAC, because the landing form has no shared secret and no auth.
 * It is the autonomous loop's inbound mouth: the public landing "what are you hoping the fleet can do?"
 * form posts here so a real prospect persists (instead of being dropped client-side) and best-effort
 * becomes a #222 discovery signal the fleet can work.
 *
 * SAFETY: no money, no outbound send, no new #13 action — capturing a lead is the safe + necessary default,
 * so it is ON whenever an owner workspace is resolved (no off-by-default gate that would leave the form
 * broken). The body is UNTRUSTED inbound DATA (#200 §6): every field is sanitized + length-capped + shape-
 * validated in `leads/inbound.ts` before anything is persisted, and the workspace is NEVER taken from the
 * body except as an explicit allow-listed override. The discovery feed is BEST-EFFORT — a discovery
 * hiccup must never fail the lead capture (the lead is already safely persisted).
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
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function leadStatus(value: unknown): InboundLeadStatus | undefined {
  return typeof value === "string" && (INBOUND_LEAD_STATUSES as readonly string[]).includes(value)
    ? value as InboundLeadStatus
    : undefined;
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || null;
}

function leadExcerpt(kind: "arrived" | "sla", lead: { name: string | null; email: string; message: string }): string {
  const who = lead.name ? `${lead.name} <${lead.email}>` : lead.email;
  const shortMessage = lead.message.length > 140 ? `${lead.message.slice(0, 137)}...` : lead.message;
  return kind === "arrived"
    ? `New inbound lead from ${who}: ${shortMessage}`
    : `24h SLA breached for inbound lead ${who}: ${shortMessage}`;
}

async function notifyOwner(app: FastifyInstance, workspaceId: string, excerpt: string): Promise<void> {
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

  app.get("/me/inbound/leads", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const q = (req.query ?? {}) as { status?: unknown; sinceMs?: unknown; limit?: unknown };
    const sinceMs = typeof q.sinceMs === "string" ? Number.parseInt(q.sinceMs, 10) : undefined;
    const limit = typeof q.limit === "string" ? Number.parseInt(q.limit, 10) : undefined;
    const leads = await listLeads(id.workspaceId, {
      status: leadStatus(q.status),
      sinceMs: Number.isFinite(sinceMs) ? sinceMs : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    for (const lead of leads) {
      if (!lead.slaBreached || lead.slaNotifiedAtMs !== null) continue;
      await notifyOwner(app, id.workspaceId, leadExcerpt("sla", lead));
      await markSlaNotified(id.workspaceId, lead.id);
    }
    return { leads };
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
    if (body.status !== undefined && !status) return reply.code(400).send({ error: "invalid lead status" });
    const assigneeMemberId = body.assigneeMemberId === undefined ? undefined : nullableText(body.assigneeMemberId);
    if (assigneeMemberId && !UUID_RE.test(assigneeMemberId)) return reply.code(400).send({ error: "invalid assigneeMemberId" });
    const nextAction = body.nextAction === undefined ? undefined : nullableText(body.nextAction);
    const respondedAt = body.respondedAt === undefined
      ? undefined
      : body.respondedAt === null
        ? null
        : typeof body.respondedAt === "string"
          ? new Date(body.respondedAt)
          : undefined;
    if (respondedAt instanceof Date && Number.isNaN(respondedAt.getTime())) {
      return reply.code(400).send({ error: "invalid respondedAt" });
    }
    const lead = await updateLead(id.workspaceId, leadId, { status, assigneeMemberId, nextAction, respondedAt });
    if (!lead) return reply.code(404).send({ error: "lead not found" });
    return { lead };
  });

  app.post("/inbound/leads", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Resolve the target workspace: the configured owner by default. A `workspaceId` in the body is only
    // honored when it EXACTLY matches the owner — the public form can never aim a lead at another tenant.
    const bodyWid = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    let workspaceId = ownerWorkspaceId ?? "";
    if (bodyWid) {
      if (!UUID_RE.test(bodyWid) || (ownerWorkspaceId && bodyWid !== ownerWorkspaceId)) {
        return reply.code(400).send({ error: "workspaceId is not accepted" });
      }
      workspaceId = bodyWid;
    }
    if (!workspaceId) {
      return reply.code(503).send({ error: "inbound lead capture is not configured" });
    }

    const sanitized = sanitizeLead({
      name: body.name,
      email: body.email,
      message: body.message,
      source: body.source,
      trackingRef: body.trackingRef,
    });
    if (!sanitized.ok) return reply.code(400).send({ error: sanitized.error });
    const lead = sanitized.lead;

    // Persist FIRST — the lead is the durable record; discovery is a best-effort enrichment on top.
    const { id } = await recordLead({
      workspaceId,
      name: lead.name,
      email: lead.email,
      message: lead.message,
      source: lead.source,
      trackingRef: lead.trackingRef,
    });

    try {
      await notifyOwner(app, workspaceId, leadExcerpt("arrived", lead));
    } catch (err) {
      recordAsyncSideEffectFailure("inbound_lead_owner_notification");
      req.log.error({ err, workspaceId, leadId: id }, "inbound lead owner notification failed after durable lead write");
    }

    // Best-effort: seed the default warm-lead definition, then feed the captured lead into #222 so a fresh
    // workspace qualifies hand-raises into the outreach stage without owner setup. The prospect key is an
    // OPAQUE hash of the email (discovery refuses an email-looking key — no PII).
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
      // A discovery hiccup never fails the capture — the lead is already persisted.
      recordAsyncSideEffectFailure("inbound_lead_discovery_ingest");
      req.log.error({ err, workspaceId, leadId: id }, "inbound lead discovery ingest failed after durable lead write");
    }

    try {
      await warmLeadFollowup?.handle({ workspaceId, leadId: id, lead });
    } catch (err) {
      recordAsyncSideEffectFailure("inbound_lead_warm_followup");
      req.log.error({ err, workspaceId, leadId: id }, "inbound lead warm follow-up failed after durable lead write");
    }

    return reply.code(202).send({ received: true });
  });
}
