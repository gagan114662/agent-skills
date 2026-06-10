import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { requireCloudWorkspaceCapability, type Capability } from "../auth/access.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import {
  createCloudWorkspace,
  getCloudWorkspace,
  listCloudWorkspaces,
  listCloudWorkspacesByIds,
} from "../db/repositories/cloud-workspaces.js";
import {
  upsertCollaborator,
  revokeCollaborator,
  listActiveCollaborators,
  listCollaboratingWorkspaceIds,
} from "../db/repositories/cloud-workspace-collaborators.js";
import { publishAccessRevoked } from "../realtime/bus.js";
import type { CloudWorkspaceManager } from "../workspace/manager.js";

export interface CloudWorkspaceRoutesOptions {
  manager: CloudWorkspaceManager;
}

const CAPABILITIES: Capability[] = ["read", "write", "propagate"];

/**
 * Persistent & shared cloud workspaces (#55, ADR-0032). A member creates a durable cloud
 * workspace (owner = implicit admin), can sleep/wake it, and can share it with scoped, revocable
 * collaborators (#9 ladder). Under the sandbox runtime (#82) sleep snapshots+stops the live
 * microVM and wake resumes a durable sandbox from that snapshot; under the default local posture
 * (no microVM) both are a status transition retaining the last snapshot. Access is
 * collaborator-gated via `requireCloudWorkspaceCapability`, which carries the #3 IDOR discipline
 * (cross-tenant = 404). Revoke cuts live access by publishing `access_revoked` on the #5 bus.
 */
export async function cloudWorkspaceRoutes(
  app: FastifyInstance,
  opts: CloudWorkspaceRoutesOptions,
): Promise<void> {
  const { manager } = opts;

  // Create a cloud workspace owned by the caller (any workspace member).
  app.post("/workspaces/:wid/cloud-workspaces", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const b = req.body as { name?: string };
    if (!b.name || !b.name.trim()) return reply.code(400).send({ error: "name required" });
    const cw = await createCloudWorkspace({
      workspaceId: wid,
      name: b.name.trim(),
      createdByMemberId: id.memberId,
    });
    return reply.code(201).send(cw);
  });

  // List the cloud workspaces the caller can see: ones they own + ones shared with them.
  app.get("/workspaces/:wid/cloud-workspaces", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const all = await listCloudWorkspaces(wid);
    const owned = all.filter((cw) => cw.createdByMemberId === id.memberId);
    const sharedIds = new Set(await listCollaboratingWorkspaceIds(id.memberId));
    const shared = (await listCloudWorkspacesByIds(wid, [...sharedIds])).filter(
      (cw) => cw.createdByMemberId !== id.memberId,
    );
    return [...owned, ...shared];
  });

  // Get one cloud workspace (read capability).
  app.get("/workspaces/:wid/cloud-workspaces/:id", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: cwId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const cw = await requireCloudWorkspaceCapability(id, cwId, "read", reply);
    if (!cw) return;
    return cw;
  });

  // Sleep a cloud workspace (write capability). Sandbox runtime: snapshot+stop the live microVM and
  // record the snapshot as the resume key; local: status-only, retaining the last snapshot.
  app.post("/workspaces/:wid/cloud-workspaces/:id/sleep", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: cwId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!(await requireCloudWorkspaceCapability(id, cwId, "write", reply))) return;
    const state = await manager.sleep(cwId, wid);
    if (!state) return reply.code(404).send({ error: "cloud workspace not found" });
    return state;
  });

  // Wake a cloud workspace (write capability). Sandbox runtime: resume a durable microVM from the
  // retained snapshot. Returns the snapshot the next session resumes from.
  app.post("/workspaces/:wid/cloud-workspaces/:id/wake", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: cwId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!(await requireCloudWorkspaceCapability(id, cwId, "write", reply))) return;
    const state = await manager.wake(cwId, wid);
    if (!state) return reply.code(404).send({ error: "cloud workspace not found" });
    return state;
  });

  // List active collaborators on a cloud workspace (read capability).
  app.get("/workspaces/:wid/cloud-workspaces/:id/collaborators", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: cwId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!(await requireCloudWorkspaceCapability(id, cwId, "read", reply))) return;
    return listActiveCollaborators(cwId);
  });

  // Invite (or re-invite) a collaborator at a scoped capability (propagate — owner/admin only).
  app.post("/workspaces/:wid/cloud-workspaces/:id/collaborators", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: cwId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!(await requireCloudWorkspaceCapability(id, cwId, "propagate", reply))) return;

    const b = req.body as { memberId?: string; capability?: string };
    if (!b.memberId) return reply.code(400).send({ error: "memberId required" });
    const capability = (b.capability ?? "read") as Capability;
    if (!CAPABILITIES.includes(capability)) {
      return reply.code(400).send({ error: "capability must be read | write | propagate" });
    }
    // Cross-tenant guard (IDOR): the invitee must be a member of THIS workspace.
    const target = await getWorkspaceMember(b.memberId, wid);
    if (!target) return reply.code(404).send({ error: "member not found in this workspace" });

    await upsertCollaborator({
      cloudWorkspaceId: cwId,
      memberId: target.id,
      capability,
      grantedByMemberId: id.memberId,
    });
    return reply.code(201).send({ ok: true, memberId: target.id, capability });
  });

  // Revoke a collaborator (propagate — owner/admin only). Cuts REST + live access immediately.
  app.delete(
    "/workspaces/:wid/cloud-workspaces/:id/collaborators/:memberId",
    async (req, reply) => {
      const id = await requireIdentity(req, reply);
      if (!id) return;
      const { wid, id: cwId, memberId } = req.params as {
        wid: string;
        id: string;
        memberId: string;
      };
      if (!assertWorkspace(id, wid, reply)) return;
      if (!(await requireCloudWorkspaceCapability(id, cwId, "propagate", reply))) return;
      // Confirm the workspace exists in this tenant before mutating (defensive; require already did).
      if (!(await getCloudWorkspace(cwId, wid))) {
        return reply.code(404).send({ error: "cloud workspace not found" });
      }
      await revokeCollaborator(cwId, memberId);
      // Best-effort live signal: drop the revoked member's watch on any connected instance (#5).
      publishAccessRevoked(cwId, memberId).catch(() => {
        /* best-effort realtime; the grant is already revoked in the source of truth */
      });
      return { ok: true, revoked: memberId };
    },
  );
}
