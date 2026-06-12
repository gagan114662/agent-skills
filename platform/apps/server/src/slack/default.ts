import type { FastifyBaseLogger } from "fastify";
import type { Identity } from "../auth/identity.js";
import { loadConfig } from "../config/loader.js";
import { isMaintenanceActive } from "../maintenance/flag.js";
import { deliverPostedMessage } from "../messaging/delivery.js";
import { postMessage } from "../db/repositories/messages.js";
import { getChannel } from "../db/repositories/channels.js";
import { getWorkspaceMember, listWorkspaceMembers } from "../db/repositories/members.js";
import { listWorkspaceIds } from "../db/repositories/workspaces.js";
import {
  getRequest,
  approveAndLock,
  rejectRequest,
  listRequests,
} from "../db/repositories/approvals.js";
import { defaultRegistry } from "../approvals/runtime.js";
import { executeApprovedRequest } from "../approvals/execute.js";
import { getMemberRole } from "../db/repositories/governance.js";
import { decideApprovalClear, resolveRbacConfig } from "../team/rbac.js";
import { getUsage } from "../db/repositories/tenant-usage.js";
import { windowKey } from "../scale/usage.js";
import { listMarketingTasks } from "../db/repositories/marketing-tasks.js";
import {
  getSlackSecrets,
  getChannelForSlackChannel,
  getMemberForSlackUser,
  getSlackUserForMember,
  linkSlackThread,
  getSlackThreadForRoot,
  markSlackEventSeen,
} from "../db/repositories/slack.js";
import { HttpSlackClient, type SlackClient } from "./client.js";
import { SlackEventService } from "./service.js";
import { resolveSlackCaps } from "./caps.js";
import { SlackDigestEngine } from "./engine.js";

/**
 * Production wiring for the Slack bridge (#170, ADR-0170). Binds the pure {@link SlackEventService} to
 * the real repos/paths: every Slack action lands on an EXISTING audited path (the #123 mention trigger
 * via `deliverPostedMessage`, the #13 decision via `approveAndLock`/`rejectRequest` +
 * `executeApprovedRequest`, the #151 RBAC `canClear`). No new authority. The outbound Slack client is
 * egress-gated by the server-level data-privacy flag (mirroring the #8 notifications transport choice).
 */
export function createDefaultSlackService(
  log: FastifyBaseLogger,
  opts: { client?: SlackClient } = {},
): SlackEventService {
  const client =
    opts.client ??
    new HttpSlackClient(undefined, {
      dataPrivacyMode: loadConfig().dataPrivacyMode,
    });
  return new SlackEventService({
    getSecrets: (workspaceId) => getSlackSecrets(workspaceId),
    client,
    resolveChannelLink: (workspaceId, slackChannelId) =>
      getChannelForSlackChannel(workspaceId, slackChannelId),
    resolveMember: (workspaceId, slackUserId) => getMemberForSlackUser(workspaceId, slackUserId),
    resolveOwner: async (workspaceId) =>
      (await listWorkspaceMembers(workspaceId)).find((m) => m.kind === "human")?.id ?? null,
    resolveSlackUser: (workspaceId, memberId) => getSlackUserForMember(workspaceId, memberId),
    postHumanMessage: async ({ workspaceId, channelId, memberId, body }) => {
      const ch = await getChannel(channelId);
      if (!ch || ch.workspaceId !== workspaceId || ch.isArchived) return null;
      const member = await getWorkspaceMember(memberId, workspaceId);
      if (!member || member.kind !== "human") return null;
      const message = await postMessage({
        workspaceId,
        channelId,
        authorMemberId: memberId,
        body,
      });
      const identity: Identity = {
        workspaceId,
        memberId,
        kind: "human",
        displayName: member.displayName,
      };
      // The SAME fan-out the REST route runs — fires the #123 @mention → real-session trigger.
      await deliverPostedMessage(log, identity, ch, message);
      return { messageId: message.id };
    },
    linkThread: (input) => linkSlackThread(input),
    getThreadForRoot: (workspaceId, rootMessageId) =>
      getSlackThreadForRoot(workspaceId, rootMessageId),
    markEventSeen: (workspaceId, eventId) => markSlackEventSeen(workspaceId, eventId),
    getRequest: (requestId) => getRequest(requestId),
    approve: (requestId, workspaceId, memberId, reason) =>
      approveAndLock(requestId, workspaceId, memberId, reason),
    reject: (requestId, workspaceId, memberId, reason) =>
      rejectRequest(requestId, workspaceId, memberId, reason),
    executeApproved: (request) => executeApprovedRequest(defaultRegistry, request, log),
    memberIsHuman: async (workspaceId, memberId) =>
      (await getWorkspaceMember(memberId, workspaceId))?.kind === "human",
    canClear: async (workspaceId, memberId) => {
      const enabled = resolveRbacConfig(loadConfig(workspaceId).rbac).enabled;
      const role = enabled ? await getMemberRole(workspaceId, memberId) : null;
      return decideApprovalClear({ rbacEnabled: enabled, role }).decision !== "deny";
    },
    digestInput: async (workspaceId) => {
      const usage = await getUsage(workspaceId, windowKey(new Date()));
      const pending = await listRequests(workspaceId, { status: "pending" });
      const tasks = await listMarketingTasks(workspaceId);
      return {
        brandName: process.env.RELOAD_BRAND_NAME?.trim() || "ipop",
        sessionsLaunched: usage.sessionsStarted,
        tasksCompleted: tasks.length,
        pendingApprovals: pending.map((r) => r.summary),
        spendCents: usage.estimatedCostCents,
      };
    },
    log,
  });
}

/** Build the production digest engine. The background timer is started in `index.ts`. */
export function createDefaultSlackDigestEngine(
  log: FastifyBaseLogger,
  service: SlackEventService,
): SlackDigestEngine {
  return new SlackDigestEngine({
    listWorkspaceIds,
    digestEnabled: (workspaceId) => resolveSlackCaps(loadConfig(workspaceId).slack).digestEnabled,
    maintenancePaused: () => isMaintenanceActive(),
    sendDigest: (workspaceId) => service.sendDigest(workspaceId),
    logger: log,
  });
}
