import type { FastifyReply, FastifyRequest } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import { addChannelMember } from "../db/repositories/channels.js";
import { grantCapability } from "../db/repositories/permissions.js";

/** The resolved, authorized launch context shared by the issue/slash session routes (#57). */
export interface ChannelLaunchContext {
  workspaceId: string;
  /** The launching human/agent member id. */
  byMemberId: string;
  channelId: string;
  /** The (validated, in-workspace) agent member that will run the session. */
  agentMemberId: string;
}

/**
 * Gate + prepare a channel agent-session launch exactly as the base `agent-sessions.ts` route does:
 * write capability on the channel, archived-channel 409, and the in-workspace **agent** IDOR check;
 * then make the agent a legitimate writer (channel member + write grant). Returns `null` after having
 * already sent the appropriate error response, so callers just `if (!ctx) return;`.
 *
 * Centralizing this keeps the #57 integration routes from drifting from the base launch's gating —
 * they confer no new authority.
 */
export async function gateChannelLaunch(
  req: FastifyRequest,
  reply: FastifyReply,
  cid: string,
  agentMemberId: string | undefined,
): Promise<ChannelLaunchContext | null> {
  const id = await requireIdentity(req, reply);
  if (!id) return null;
  const ch = await requireChannelCapability(id, cid, "write", reply);
  if (!ch) return null;
  if (ch.isArchived) {
    reply.code(409).send({ error: "channel is archived" });
    return null;
  }
  if (!agentMemberId) {
    reply.code(400).send({ error: "agentMemberId required" });
    return null;
  }
  const target = await getWorkspaceMember(agentMemberId, id.workspaceId);
  if (!target) {
    reply.code(404).send({ error: "agent not found in this workspace" });
    return null;
  }
  if (target.kind !== "agent") {
    reply.code(400).send({ error: "agentMemberId must reference an agent member" });
    return null;
  }
  await addChannelMember(cid, target.id);
  await grantCapability({
    workspaceId: id.workspaceId,
    memberId: target.id,
    resourceType: "channel",
    resourceId: cid,
    capability: "write",
    grantedByMemberId: id.memberId,
  });
  return {
    workspaceId: id.workspaceId,
    byMemberId: id.memberId,
    channelId: cid,
    agentMemberId: target.id,
  };
}
