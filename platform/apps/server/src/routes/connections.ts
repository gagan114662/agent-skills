import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import {
  CONNECTION_DESCRIPTORS,
  getConnectionDescriptor,
} from "../connections/registry.js";
import { decideConnectionView, decideInternalConnect } from "../connections/view.js";
import { createDefaultConnectOnceService } from "../connections/default.js";
import {
  listServiceStatuses,
  setServiceCredentials,
  revokeServiceCredentials,
} from "../db/repositories/external-credentials.js";

/**
 * Connections routes (#258) — the OAuth-first "connect once, the agents do the rest" surface. All
 * `/me/*`-scoped to the caller's workspace (#3).
 *
 *  - `GET /me/connections` lists what the workspace can connect. Customer connectors (consumer OAuth:
 *    "Sign in with Google", "Connect X", "Connect your website") are always listed; the INTERNAL GitHub
 *    site-publish connector is listed ONLY for the owner/admin workspace — a non-technical customer never
 *    sees a repo, a PR, or a token.
 *  - `POST /me/connections/:id/connect` is the INTERNAL paste path (admin only): it seals a GitHub token +
 *    repo into the encrypted #192 vault so `publish_site` no longer needs a Fly server secret. It refuses
 *    a non-owner and refuses an OAuth (customer) connector outright.
 *  - `POST /me/connections/:id/oauth/start` is the consumer-OAuth seam. The live redirect flow is a
 *    follow-up; today it 501s with `status: "coming_soon"` so the UI is honest. The model is already
 *    OAuth-shaped, so the redirect slots in here without re-modelling.
 *
 * Connecting is a one-time CONSENT, not money — so it carries no #13 gate (consistent with #243 money-only
 * and the #192 non-money connects). Real spend through a connected channel stays money-gated, unchanged.
 */
export async function connectionsRoutes(app: FastifyInstance): Promise<void> {
  function isOwnerWorkspace(workspaceId: string): boolean {
    return loadConfig(workspaceId).marketing.ownerWorkspaceId === workspaceId;
  }

  async function connectedIds(workspaceId: string): Promise<Set<string>> {
    const rows = await listServiceStatuses(workspaceId);
    return new Set(rows.filter((r) => r.connected).map((r) => r.serviceKey));
  }

  // What this workspace can connect (+ which are already connected). Read-only, never a secret.
  app.get("/me/connections", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const isOwner = isOwnerWorkspace(wid);
    const connections = decideConnectionView({
      descriptors: CONNECTION_DESCRIPTORS,
      connectedIds: await connectedIds(wid),
      isOwner,
    });
    return { connections, canManageInternal: isOwner };
  });

  // INTERNAL paste connect (admin only): seal the GitHub token + repo into the encrypted vault.
  app.post("/me/connections/:id/connect", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { repo?: unknown; token?: unknown; baseBranch?: unknown };
    const decision = decideInternalConnect({
      descriptor: getConnectionDescriptor(id),
      isOwner: isOwnerWorkspace(wid),
      repo: typeof body.repo === "string" ? body.repo : undefined,
      token: typeof body.token === "string" ? body.token : undefined,
      baseBranch: typeof body.baseBranch === "string" ? body.baseBranch : undefined,
    });
    if (!decision.ok) return reply.code(400).send({ error: decision.reason });
    await setServiceCredentials({
      workspaceId: wid,
      serviceKey: decision.serviceKey,
      secrets: decision.secrets,
      scopes: decision.scopes,
      connectedByMemberId: identity.memberId,
    });
    // Re-read so the caller sees the freshly-connected state — never the secret.
    const connections = decideConnectionView({
      descriptors: CONNECTION_DESCRIPTORS,
      connectedIds: await connectedIds(wid),
      isOwner: isOwnerWorkspace(wid),
    });
    return { connected: true, id: decision.serviceKey, connections };
  });

  // Consumer-OAuth seam (#258 Stage 2) — the shared connect-once flow. When the live flow is OUT of scope
  // for this workspace (flag OFF / not the owner workspace / no live provider wired) it stays the honest
  // `coming_soon` (501, today's behavior). When it IS in scope, connecting an outside account ALWAYS pauses
  // for an explicit owner approval: the service parks a PENDING `connection.connect_account` #13 request and
  // we return its id — the live redirect + token exchange + vault seal behind that gate is the per-department
  // follow-up (#265/#268/#269/#272), so nothing is connected without the owner's yes.
  const connectOnce = createDefaultConnectOnceService();
  app.post("/me/connections/:id/oauth/start", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const id = (req.params as { id: string }).id;
    const descriptor = getConnectionDescriptor(id);
    if (!descriptor || descriptor.auth !== "oauth") {
      return reply.code(400).send({ error: "not an OAuth connection" });
    }
    const result = await connectOnce.startConnect(
      { workspaceId: identity.workspaceId, requesterMemberId: identity.memberId },
      descriptor,
    );
    if (result.status === "pending_approval") {
      return reply.code(202).send({
        status: "pending_approval",
        requestId: result.requestId,
        provider: descriptor.provider,
        scopes: descriptor.oauthScopes,
        message: `Connecting ${descriptor.label} needs your approval — it's waiting in your decision queue.`,
      });
    }
    return reply.code(501).send({
      status: "coming_soon",
      provider: descriptor.provider,
      scopes: descriptor.oauthScopes,
      message: result.reason,
    });
  });

  // Disconnect — dependent capabilities go offline gracefully (the vault marks the row revoked).
  // Internal connections (the GitHub site-publish paste) are admin-only: a non-owner can't revoke one.
  app.delete("/me/connections/:id", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const id = (req.params as { id: string }).id;
    const descriptor = getConnectionDescriptor(id);
    if (descriptor?.audience === "internal" && !isOwnerWorkspace(identity.workspaceId)) {
      return reply.code(403).send({ error: "internal connection — admin only" });
    }
    await revokeServiceCredentials(identity.workspaceId, id);
    return { revoked: true, id };
  });
}
