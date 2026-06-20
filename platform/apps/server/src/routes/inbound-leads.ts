import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DiscoveryService } from "../discovery/service.js";
import { recordLead } from "../db/repositories/inbound-leads.js";
import { sanitizeLead, toDiscoverySignal } from "../leads/inbound.js";

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
  /**
   * The workspace a public landing lead belongs to (the marketing-owner workspace). When unset, the public
   * form is not wired to a workspace and the route 503s — but a `workspaceId` in the body is still honored
   * if it matches this owner (so a dev/staging deploy without the env var can opt a single workspace in).
   */
  ownerWorkspaceId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function inboundLeadsRoutes(
  app: FastifyInstance,
  opts: InboundLeadsRoutesOptions,
): Promise<void> {
  const { discovery, ownerWorkspaceId } = opts;

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

    // Best-effort: feed the captured lead into the #222 discovery engine so the fleet can rank + work it.
    // The prospect key is an OPAQUE hash of the email (discovery refuses an email-looking key — no PII).
    try {
      const prospectKeyHash = createHash("sha256").update(lead.email).digest("hex").slice(0, 32);
      const signal = toDiscoverySignal(lead, prospectKeyHash);
      await discovery.ingestSignal(workspaceId, {
        prospectKey: signal.prospectKey,
        kind: signal.kind,
        role: signal.role,
        source: signal.source,
        detail: signal.detail,
      });
    } catch (err) {
      // A discovery hiccup never fails the capture — the lead is already persisted.
      req.log.warn({ err, leadId: id }, "inbound lead captured but discovery ingest failed");
    }

    return reply.code(202).send({ received: true });
  });
}
