/**
 * Production wiring for the agent→channel message bridge (#370, ADR-0370). Binds the gated dispatcher to
 * the real seams: per-workspace caps from the layered config (#58), channel lookup by blueprint name, the
 * ACTIVE agent member by @handle (so the post is authored as a kind="agent" row — never a human), the
 * owner's display name for the approval @mention, and the SAME `postMessage` write the REST channel route
 * uses. No new store, no new authority — just a narrator on top of the existing audited paths.
 */
import { loadConfig } from "../config/loader.js";
import { listChannels } from "../db/repositories/channels.js";
import { getAgentMemberByHandle } from "../db/repositories/auth.js";
import { getWorkspaceMember, getWorkspaceOwnerMemberId } from "../db/repositories/members.js";
import { postMessage } from "../db/repositories/messages.js";
import { resolveAgentChannelPostingCaps } from "./caps.js";
import { CoordinationChannelBridge } from "./bridge.js";

export function createCoordinationChannelBridge(): CoordinationChannelBridge {
  return new CoordinationChannelBridge({
    caps: (workspaceId) => resolveAgentChannelPostingCaps(loadConfig(workspaceId).agentChannelPosting),
    resolveChannelId: async (workspaceId, channelName) => {
      const ch = (await listChannels(workspaceId)).find((c) => c.name === channelName);
      return ch?.id;
    },
    resolveAgentMember: async (workspaceId, handle) => {
      const m = await getAgentMemberByHandle(workspaceId, handle);
      return m ? { memberId: m.memberId } : undefined;
    },
    resolveOwnerName: async (workspaceId) => {
      const ownerId = await getWorkspaceOwnerMemberId(workspaceId);
      if (!ownerId) return undefined;
      const member = await getWorkspaceMember(ownerId, workspaceId);
      return member?.displayName;
    },
    post: (input) =>
      postMessage({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        authorMemberId: input.authorMemberId,
        body: input.body,
      }),
  });
}
