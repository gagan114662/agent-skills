import type { FastifyReply } from "fastify";
import type { Identity } from "./identity.js";
import { getChannel, isChannelMember, type Channel } from "../db/repositories/channels.js";
import { getCapability, type Capability } from "../db/repositories/permissions.js";
import { getTask, type Task } from "../db/repositories/tasks.js";
import { getRequest, type ApprovalRequest } from "../db/repositories/approvals.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import { getCloudWorkspace, type CloudWorkspace } from "../db/repositories/cloud-workspaces.js";
import { getActiveCollaborator } from "../db/repositories/cloud-workspace-collaborators.js";

export type { Capability };

/**
 * The RBAC ladder (issue #9): read < write < propagate. Capabilities are cumulative —
 * a higher rank implies every lower one.
 */
const RANK: Record<Capability, number> = { read: 1, write: 2, propagate: 3 };

/** True when the held capability meets or exceeds the needed one. */
export function satisfies(have: Capability, needed: Capability): boolean {
  return RANK[have] >= RANK[needed];
}

/**
 * A member's effective capability on a resource, layered on #4 membership:
 *   - non-member  → null (no access; membership is still the first gate, ADR-0004)
 *   - explicit grant present → that level (a `read` grant is a deliberate downgrade)
 *   - member, no grant → `write` (preserves #4: every channel member could post)
 */
export function effectiveCapability(
  explicit: Capability | null,
  isMember: boolean,
): Capability | null {
  if (!isMember) return null;
  return explicit ?? "write";
}

/**
 * Load a channel and assert the caller may act on it at `needed` level. The single access
 * call routes make — keeps routes thin. On failure it sends the response (404 cross-workspace
 * / not-found, 403 insufficient capability) and returns undefined.
 */
export async function requireChannelCapability(
  identity: Identity,
  channelId: string,
  needed: Capability,
  reply: FastifyReply,
): Promise<Channel | undefined> {
  const ch = await getChannel(channelId);
  if (!ch || ch.workspaceId !== identity.workspaceId) {
    reply.code(404).send({ error: "channel not found" });
    return undefined;
  }
  const isMember = await isChannelMember(channelId, identity.memberId);
  const explicit = await getCapability(identity.workspaceId, identity.memberId, "channel", channelId);
  const effective = effectiveCapability(explicit, isMember);
  if (!effective) {
    reply.code(403).send({ error: "not a channel member" });
    return undefined;
  }
  if (!satisfies(effective, needed)) {
    reply.code(403).send({ error: `requires ${needed} capability` });
    return undefined;
  }
  return ch;
}

/**
 * The effective channel capability for an **arbitrary** member (not the request identity), using the
 * same #4-membership + #9-grant layering as {@link requireChannelCapability}. Returns null when the
 * member is not on the channel (and has no explicit grant). Used by the subagent dispatcher (#59) to
 * assert a persona's own member is permitted in the target channel before launching it as that
 * member — the persona can never act beyond its own grants.
 */
export async function effectiveChannelCapabilityFor(
  workspaceId: string,
  memberId: string,
  channelId: string,
): Promise<Capability | null> {
  const isMember = await isChannelMember(channelId, memberId);
  const explicit = await getCapability(workspaceId, memberId, "channel", channelId);
  return effectiveCapability(explicit, isMember);
}

/**
 * Load a task and assert it belongs to the caller's workspace (#14). Tasks are workspace-scoped
 * (membership is the gate, no per-task RBAC yet), so this is the single access call task-id routes
 * make — it carries the #3 IDOR discipline: a task in another workspace is a 404, never readable.
 */
export async function requireTaskInWorkspace(
  identity: Identity,
  taskId: string,
  reply: FastifyReply,
): Promise<Task | undefined> {
  const task = await getTask(taskId);
  if (!task || task.workspaceId !== identity.workspaceId) {
    reply.code(404).send({ error: "task not found" });
    return undefined;
  }
  return task;
}

/**
 * Load an approval request and assert it belongs to the caller's workspace (#13). Approval requests
 * are workspace-scoped (access is by workspace membership; *deciding* additionally requires the
 * caller be human — enforced at the route). The single access call request-id routes make — carries
 * the #3 IDOR discipline: a request in another workspace is a 404, never readable.
 */
export async function requireApprovalInWorkspace(
  identity: Identity,
  requestId: string,
  reply: FastifyReply,
): Promise<ApprovalRequest | undefined> {
  const request = await getRequest(requestId);
  if (!request || request.workspaceId !== identity.workspaceId) {
    reply.code(404).send({ error: "approval request not found" });
    return undefined;
  }
  return request;
}

/**
 * A member's effective capability on a **cloud workspace** (issue #55), layered on the #9 ladder:
 *   - owner (created_by)        → `propagate` (implicit admin; outranks any collaborator row)
 *   - active collaborator       → the granted capability
 *   - no row / revoked          → null (no access)
 * Sharing is collaborator-gated (not channel/workspace membership): a member sees a cloud
 * workspace only if they own it or hold an un-revoked collaborator grant.
 */
export function effectiveCloudWorkspaceCapability(
  isOwner: boolean,
  collaborator: { capability: Capability; revokedAt: Date | null } | null,
): Capability | null {
  if (isOwner) return "propagate";
  if (!collaborator || collaborator.revokedAt) return null;
  return collaborator.capability;
}

/**
 * Resolve the caller's effective capability on a cloud workspace, or null if they cannot see it.
 * Carries the #3 IDOR discipline: a workspace in another tenant resolves to null (→ 404 at the
 * route). Shared by the REST guard and the realtime gateway (which has no `reply`).
 */
export async function resolveCloudWorkspaceCapability(
  identity: Identity,
  cloudWorkspaceId: string,
): Promise<{ cw: CloudWorkspace; capability: Capability } | null> {
  const cw = await getCloudWorkspace(cloudWorkspaceId, identity.workspaceId);
  if (!cw) return null;
  const isOwner = cw.createdByMemberId === identity.memberId;
  const collaborator = isOwner
    ? null
    : (await getActiveCollaborator(cloudWorkspaceId, identity.memberId)) ?? null;
  const capability = effectiveCloudWorkspaceCapability(isOwner, collaborator);
  return capability ? { cw, capability } : null;
}

/**
 * Load a cloud workspace and assert the caller may act on it at `needed` level (#55). The single
 * access call cloud-workspace routes make — sends the response on failure (404 not-found /
 * cross-tenant, 403 insufficient) and returns undefined.
 */
export async function requireCloudWorkspaceCapability(
  identity: Identity,
  cloudWorkspaceId: string,
  needed: Capability,
  reply: FastifyReply,
): Promise<CloudWorkspace | undefined> {
  const resolved = await resolveCloudWorkspaceCapability(identity, cloudWorkspaceId);
  if (!resolved) {
    reply.code(404).send({ error: "cloud workspace not found" });
    return undefined;
  }
  if (!satisfies(resolved.capability, needed)) {
    reply.code(403).send({ error: `requires ${needed} capability on cloud workspace` });
    return undefined;
  }
  return resolved.cw;
}

/**
 * A member's effective capability on the **workspace memory graph** (issue #16). Memory is one
 * shared resource per workspace (`resource_type='memory'`, `resource_id=workspace_id`), layered
 * on workspace membership:
 *   - non-member        → null (no access)
 *   - explicit grant    → that level (e.g. an agent deliberately downgraded to `read`)
 *   - human, no grant   → `propagate` (humans administer the graph)
 *   - agent, no grant   → `write`     (agents collaborate by default — the shared-memory default)
 */
export function effectiveMemoryCapability(
  explicit: Capability | null,
  memberKind: "human" | "agent" | null,
): Capability | null {
  if (memberKind === null) return null;
  return explicit ?? (memberKind === "human" ? "propagate" : "write");
}

/**
 * Assert the caller may act on `workspaceId`'s memory graph at `needed` level (issue #16). The
 * single access call memory routes make: carries the #3 IDOR discipline (a caller from another
 * workspace is rejected) and the #9 RBAC ladder. Sends the response on failure and returns false.
 */
export async function requireMemoryCapability(
  identity: Identity,
  workspaceId: string,
  needed: Capability,
  reply: FastifyReply,
): Promise<boolean> {
  if (identity.workspaceId !== workspaceId) {
    reply.code(403).send({ error: "wrong workspace" });
    return false;
  }
  const member = await getWorkspaceMember(identity.memberId, workspaceId);
  const explicit = await getCapability(workspaceId, identity.memberId, "memory", workspaceId);
  const effective = effectiveMemoryCapability(explicit, member?.kind ?? null);
  if (!effective) {
    reply.code(403).send({ error: "not a workspace member" });
    return false;
  }
  if (!satisfies(effective, needed)) {
    reply.code(403).send({ error: `requires ${needed} capability on memory` });
    return false;
  }
  return true;
}
