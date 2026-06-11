import type { FastifyInstance, FastifyReply } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { Identity } from "../auth/identity.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import {
  getMemberRole,
  setMemberRole,
  removeMemberRole,
  listMemberRoles,
  hasAnyOwner,
  createInvite,
  listInvites,
  revokeInvite,
  getPendingInviteByTokenHash,
  acceptInvite,
} from "../db/repositories/governance.js";
import { listViolations } from "../db/repositories/egress.js";
import { generateSessionToken, hashToken } from "../auth/secrets.js";
import { loadConfig } from "../config/loader.js";
import { resolveEgressPolicy } from "../runtime/egress-allowlist.js";
import { canManageGovernance, decideInvite, isWorkspaceRole } from "../team/rbac.js";

/**
 * Governance & trust routes (#151, ADR-0151). Workspace role management + email invites + the
 * flagged-domains egress report. Routes stay thin: tenant guard + a governance-manager check + the
 * pure `team/rbac` decisions; all DB logic in the repos (the #9/#14 pattern).
 *
 * Authority model: managing governance (assigning roles, sending/revoking invites) requires the `owner`
 * role — EXCEPT a bootstrap allowance: when a workspace has no owner yet, any human member may establish
 * the first owner (otherwise a brand-new workspace could never assign anyone). Reads (role list, egress
 * report, policy) are open to any member of the workspace.
 */
export async function governanceRoutes(app: FastifyInstance): Promise<void> {
  /** Owner (or bootstrap when no owner exists) may manage governance. Sends 403 + returns false on deny. */
  async function requireGovernanceManager(
    id: Identity,
    workspaceId: string,
    reply: FastifyReply,
  ): Promise<boolean> {
    const role = await getMemberRole(workspaceId, id.memberId);
    if (role && canManageGovernance(role)) return true;
    if (id.kind === "human" && !(await hasAnyOwner(workspaceId))) return true; // bootstrap
    await reply.code(403).send({ error: "only an owner can manage governance" });
    return false;
  }

  // --- roles ---

  app.get("/workspaces/:wid/governance/roles", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return { roles: await listMemberRoles(wid), hasOwner: await hasAnyOwner(wid) };
  });

  app.put("/workspaces/:wid/governance/roles/:mid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, mid } = req.params as { wid: string; mid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!(await requireGovernanceManager(id, wid, reply))) return;
    const role = (req.body as { role?: unknown })?.role;
    if (!isWorkspaceRole(role)) return reply.code(400).send({ error: "invalid role" });
    const target = await getWorkspaceMember(mid, wid);
    if (!target) return reply.code(404).send({ error: "member not found in this workspace" });
    await setMemberRole({ workspaceId: wid, memberId: mid, role, grantedByMemberId: id.memberId });
    return reply.code(200).send({ memberId: mid, role });
  });

  app.delete("/workspaces/:wid/governance/roles/:mid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, mid } = req.params as { wid: string; mid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!(await requireGovernanceManager(id, wid, reply))) return;
    await removeMemberRole(wid, mid);
    return reply.code(200).send({ memberId: mid, role: null });
  });

  // --- invites ---

  app.post("/workspaces/:wid/governance/invites", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!(await requireGovernanceManager(id, wid, reply))) return;
    const decision = decideInvite(req.body as { email?: unknown; role?: unknown });
    if (!decision.ok) return reply.code(400).send({ error: decision.reason });
    // The raw token is shown to the inviter ONCE (to share with the recipient); only its hash is stored.
    // Actual email delivery is a documented seam (no SMTP wired) — the invite row is the durable artifact.
    const { raw } = generateSessionToken();
    const invite = await createInvite({
      workspaceId: wid,
      email: decision.email!,
      role: decision.role!,
      tokenHash: hashToken(raw),
      invitedByMemberId: id.memberId,
    });
    return reply.code(201).send({
      invite: { id: invite.id, email: invite.email, role: invite.role, status: invite.status },
      token: raw, // shown once
    });
  });

  app.get("/workspaces/:wid/governance/invites", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!(await requireGovernanceManager(id, wid, reply))) return;
    const invites = await listInvites(wid);
    // Never surface token hashes.
    return {
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        status: i.status,
        createdAt: i.createdAt,
        acceptedAt: i.acceptedAt,
      })),
    };
  });

  app.post("/workspaces/:wid/governance/invites/:iid/revoke", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, iid } = req.params as { wid: string; iid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!(await requireGovernanceManager(id, wid, reply))) return;
    await revokeInvite(wid, iid);
    return reply.code(200).send({ id: iid, status: "revoked" });
  });

  /**
   * Accept an invite: bind its role to the accepting member. The caller must be a human member of the
   * invite's workspace (the new-user-from-email signup path is a documented seam). Validates the raw
   * token against the stored hash.
   */
  app.post("/workspaces/:wid/governance/invites/accept", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (id.kind !== "human") return reply.code(403).send({ error: "only a human member can accept" });
    const token = (req.body as { token?: unknown })?.token;
    if (typeof token !== "string" || !token) return reply.code(400).send({ error: "token required" });
    const invite = await getPendingInviteByTokenHash(hashToken(token));
    if (!invite || invite.workspaceId !== wid) {
      return reply.code(404).send({ error: "invite not found or already used" });
    }
    const accepted = await acceptInvite(invite.id, id.memberId);
    if (!accepted) return reply.code(409).send({ error: "invite already used" });
    await setMemberRole({
      workspaceId: wid,
      memberId: id.memberId,
      role: invite.role,
      grantedByMemberId: invite.invitedByMemberId,
    });
    return reply.code(200).send({ role: invite.role });
  });

  // --- egress report (the flagged-domains report) ---

  app.get("/workspaces/:wid/egress/policy", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return resolveEgressPolicy(loadConfig(wid).egress);
  });

  app.get("/workspaces/:wid/egress/violations", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const { limit } = req.query as { limit?: string };
    const n = limit ? Number(limit) : undefined;
    const violations = await listViolations(wid, n && Number.isFinite(n) ? { limit: n } : {});
    return { violations };
  });
}
