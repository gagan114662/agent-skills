import type { FastifyBaseLogger } from "fastify";
import type { ApprovalRequest, DecisionOutcome } from "../db/repositories/approvals.js";
import type { ApprovalExecutionOutcome } from "../approvals/execute.js";
import type { ChannelPostHookInput } from "../runtime/default.js";
import type { SlackClient } from "./client.js";
import type { SlackSecrets } from "../db/repositories/slack.js";
import { slackMentionToPlatformMessage } from "./mention-parse.js";
import { parseApprovalActionValue, buildApprovalBlocks, type SlackBlock } from "./blocks.js";
import { buildSlackDigest, type SlackDigestInput } from "./digest.js";
import { SLACK_VOICE } from "./voice.js";

/**
 * The Slack bridge (#170, ADR-0170). Translates inbound Slack events/interactions into the EXISTING
 * audited platform paths and mirrors the platform's outputs back into Slack — it adds NO new launch or
 * approval authority. Every DB/IO touch is an injected seam, so the whole bridge is tested offline with
 * a fake `SlackClient` + fake repos, and the integration test drives it with real wiring + a recording
 * client.
 *
 * Inbound posture (criterion 4): the only outbound Slack traffic is (a) an agent's reply mirrored into
 * the thread a human started and (b) the opt-in digest DM. We never cold-post into a customer channel,
 * and an agent's drafted external send still routes through the #13 gate — Slack is a surface, not an
 * egress bypass.
 */

export interface SlackServiceDeps {
  /** Decrypted Slack secrets for a workspace, or null when not connected. */
  getSecrets(workspaceId: string): Promise<SlackSecrets | null>;
  client: SlackClient;
  /** The platform channel a Slack channel is linked to, or null. */
  resolveChannelLink(workspaceId: string, slackChannelId: string): Promise<string | null>;
  /** The platform member a Slack user is linked to, or null. */
  resolveMember(workspaceId: string, slackUserId: string): Promise<string | null>;
  /** The workspace owner (earliest human member) — the fallback acting identity + digest recipient. */
  resolveOwner(workspaceId: string): Promise<string | null>;
  /** The Slack user id linked to a member (for DM addressing), or null. */
  resolveSlackUser(workspaceId: string, memberId: string): Promise<string | null>;
  /**
   * Post a message AS a human member through the EXISTING post path (so `deliverPostedMessage` fires
   * the #123 mention trigger). Returns the new message id, or null if the channel/member is invalid.
   */
  postHumanMessage(input: {
    workspaceId: string;
    channelId: string;
    memberId: string;
    body: string;
  }): Promise<{ messageId: string } | null>;
  /** Record the Slack thread an @mention's root message belongs to. */
  linkThread(input: {
    workspaceId: string;
    rootMessageId: string;
    slackChannelId: string;
    slackThreadTs: string;
  }): Promise<void>;
  /** The Slack thread a platform thread root maps to, or null. */
  getThreadForRoot(
    workspaceId: string,
    rootMessageId: string,
  ): Promise<{ slackChannelId: string; slackThreadTs: string } | null>;
  /** Dedupe: true the first time an event id is seen, false on a retry. */
  markEventSeen(workspaceId: string, eventId: string): Promise<boolean>;
  // --- approvals round-trip (#13 reused verbatim) ---
  getRequest(requestId: string): Promise<ApprovalRequest | undefined>;
  approve(
    requestId: string,
    workspaceId: string,
    memberId: string,
    reason: string | null,
  ): Promise<DecisionOutcome>;
  reject(
    requestId: string,
    workspaceId: string,
    memberId: string,
    reason: string | null,
  ): Promise<DecisionOutcome>;
  /** Execute an approved request through the SAME #13 executor path the REST route uses. */
  executeApproved(request: ApprovalRequest): Promise<ApprovalExecutionOutcome>;
  /** True if the member is a human in the workspace (the #13 humans-only gate). */
  memberIsHuman(workspaceId: string, memberId: string): Promise<boolean>;
  /** True if the member's role may clear approvals (#151 RBAC; permissive when RBAC is OFF). */
  canClear(workspaceId: string, memberId: string): Promise<boolean>;
  /** Build the digest input (fleet activity / pending / spend) from the #104 aggregate. */
  digestInput(workspaceId: string): Promise<SlackDigestInput>;
  log: FastifyBaseLogger;
}

export class SlackEventService {
  constructor(private readonly deps: SlackServiceDeps) {}

  /** Whether a workspace has connected a Slack app (the route's 503 gate). */
  async isConnected(workspaceId: string): Promise<boolean> {
    return (await this.deps.getSecrets(workspaceId)) !== null;
  }

  /**
   * Handle an inbound Slack Events API delivery (`event_callback`). Currently only `app_mention` is
   * actioned: it is posted into the linked platform channel AS the acting member, so the existing
   * #123 trigger launches the session. Deduped by Slack event id. Returns a short status for logging.
   */
  async handleEvent(
    workspaceId: string,
    payload: { event_id?: string; event?: Record<string, unknown> },
  ): Promise<{ status: "ignored" | "duplicate" | "launched" }> {
    const event = payload.event;
    if (!event || event.type !== "app_mention") return { status: "ignored" };
    const eventId = typeof payload.event_id === "string" ? payload.event_id : null;
    if (eventId) {
      const fresh = await this.deps.markEventSeen(workspaceId, eventId);
      if (!fresh) return { status: "duplicate" };
    }

    const slackChannelId = typeof event.channel === "string" ? event.channel : null;
    const slackUserId = typeof event.user === "string" ? event.user : null;
    const rawText = typeof event.text === "string" ? event.text : "";
    if (!slackChannelId) return { status: "ignored" };

    const channelId = await this.deps.resolveChannelLink(workspaceId, slackChannelId);
    if (!channelId) return { status: "ignored" };

    // Acting identity: the linked member, else the workspace owner (the connector). A mention always
    // launches as a real human on a channel they own — never an anonymous/agent identity.
    const linkedMember = slackUserId
      ? await this.deps.resolveMember(workspaceId, slackUserId)
      : null;
    const memberId = linkedMember ?? (await this.deps.resolveOwner(workspaceId));
    if (!memberId) return { status: "ignored" };

    const body = slackMentionToPlatformMessage(rawText);
    if (!body) return { status: "ignored" };

    const posted = await this.deps.postHumanMessage({ workspaceId, channelId, memberId, body });
    if (!posted) return { status: "ignored" };

    // Record the Slack thread so the agent's reply mirrors back here. Slack threads under `thread_ts`
    // when present, else the message's own `ts` (so the reply starts the thread).
    const threadTs =
      (typeof event.thread_ts === "string" && event.thread_ts) ||
      (typeof event.ts === "string" && event.ts) ||
      null;
    if (threadTs) {
      await this.deps.linkThread({
        workspaceId,
        rootMessageId: posted.messageId,
        slackChannelId,
        slackThreadTs: threadTs,
      });
    }
    return { status: "launched" };
  }

  /**
   * Mirror an agent's channel reply back into the Slack thread the human started (#170). Fired for
   * every agent post via the `channelPoster` hook; a no-op unless the reply's `parentMessageId` maps to
   * a recorded Slack thread, so only replies to a Slack-originated mention leave the box.
   */
  async handleAgentPost(post: ChannelPostHookInput): Promise<void> {
    if (!post.parentMessageId) return;
    const thread = await this.deps.getThreadForRoot(post.workspaceId, post.parentMessageId);
    if (!thread) return;
    const secrets = await this.deps.getSecrets(post.workspaceId);
    if (!secrets) return;
    await this.deps.client.postMessage(secrets.botToken, {
      channel: thread.slackChannelId,
      text: post.body,
      threadTs: thread.slackThreadTs,
    });
  }

  /**
   * Handle a Block Kit interactivity payload (an Approve/Reject button click). Resolves the clicking
   * Slack user → member and round-trips through the SAME #13 decision path the REST route uses,
   * enforcing the IDENTICAL guards: humans only, cannot approve your own request, RBAC `canClear`, CAS
   * lock, append-only audit. Returns the ack text to show in Slack. The Slack button is a new *trigger*
   * for the gate, not a new gate.
   */
  async handleInteractivity(
    workspaceId: string,
    payload: {
      user?: { id?: unknown };
      actions?: Array<{ action_id?: unknown; value?: unknown }>;
    },
  ): Promise<{ ack: string }> {
    const action = payload.actions?.[0];
    if (!action) return { ack: SLACK_VOICE.alreadyDecided };
    const actionId = typeof action.action_id === "string" ? action.action_id : "";
    const parsed = parseApprovalActionValue(action.value);
    // Tenant scoping: the value's workspace MUST match the signed route's workspace (no cross-tenant).
    if (!parsed || parsed.workspaceId !== workspaceId) return { ack: SLACK_VOICE.alreadyDecided };

    const slackUserId = typeof payload.user?.id === "string" ? payload.user.id : null;
    const memberId = slackUserId ? await this.deps.resolveMember(workspaceId, slackUserId) : null;
    if (!memberId) return { ack: SLACK_VOICE.cannotDecide };

    // #13 guards — identical to the REST route. Humans only; RBAC canClear; cannot decide your own.
    if (!(await this.deps.memberIsHuman(workspaceId, memberId))) {
      return { ack: SLACK_VOICE.cannotDecide };
    }
    if (!(await this.deps.canClear(workspaceId, memberId))) {
      return { ack: SLACK_VOICE.cannotDecide };
    }
    const request = await this.deps.getRequest(parsed.requestId);
    if (!request || request.workspaceId !== workspaceId) return { ack: SLACK_VOICE.alreadyDecided };
    if (request.requesterMemberId === memberId) return { ack: SLACK_VOICE.cannotDecide };

    if (actionId.endsWith("reject")) {
      const decision = await this.deps.reject(parsed.requestId, workspaceId, memberId, "via Slack");
      if (decision.outcome !== "rejected") return { ack: SLACK_VOICE.alreadyDecided };
      return { ack: SLACK_VOICE.rejectedAck };
    }

    const decision = await this.deps.approve(parsed.requestId, workspaceId, memberId, "via Slack");
    if (decision.outcome !== "approved") return { ack: SLACK_VOICE.alreadyDecided };
    const execution = await this.deps.executeApproved(decision.request);
    if (execution.outcome === "conflict") return { ack: SLACK_VOICE.alreadyDecided };
    return { ack: SLACK_VOICE.approvedAck };
  }

  /**
   * DM the owner a pending approval with Approve/Reject buttons (#170). Best-effort: a workspace with
   * no Slack connection / no linked owner Slack user is a silent no-op (the in-app #8 notification
   * still fired). Registered as the #170 approval-pending hook.
   */
  async notifyApprovalPending(request: ApprovalRequest): Promise<void> {
    const secrets = await this.deps.getSecrets(request.workspaceId);
    if (!secrets) return;
    const ownerMemberId = await this.deps.resolveOwner(request.workspaceId);
    if (!ownerMemberId) return;
    const ownerSlackUser = await this.deps.resolveSlackUser(request.workspaceId, ownerMemberId);
    if (!ownerSlackUser) return;
    const dm = await this.deps.client.openDm(secrets.botToken, ownerSlackUser);
    if (!dm) return;
    await this.deps.client.postMessage(secrets.botToken, {
      channel: dm.channel,
      text: `${SLACK_VOICE.approvalTitle}: ${request.summary}`,
      blocks: buildApprovalBlocks({
        requestId: request.id,
        workspaceId: request.workspaceId,
        summary: request.summary,
      }),
    });
  }

  /**
   * Build + DM the daily fleet digest to the owner (#170). Pure copy via `buildSlackDigest`; the engine
   * gates this behind `slack.digestEnabled`, so reaching here already means the workspace opted in.
   */
  async sendDigest(workspaceId: string): Promise<{ sent: boolean }> {
    const secrets = await this.deps.getSecrets(workspaceId);
    if (!secrets) return { sent: false };
    const ownerMemberId = await this.deps.resolveOwner(workspaceId);
    if (!ownerMemberId) return { sent: false };
    const ownerSlackUser = await this.deps.resolveSlackUser(workspaceId, ownerMemberId);
    if (!ownerSlackUser) return { sent: false };
    const dm = await this.deps.client.openDm(secrets.botToken, ownerSlackUser);
    if (!dm) return { sent: false };
    const digest = buildSlackDigest(await this.deps.digestInput(workspaceId));
    const res = await this.deps.client.postMessage(secrets.botToken, {
      channel: dm.channel,
      text: digest.text,
      blocks: digest.blocks,
    });
    return { sent: res !== null };
  }

  /**
   * DM an arbitrary message to the workspace owner (#170). The reusable owner-DM primitive behind
   * {@link sendDigest} / {@link notifyApprovalPending}: resolve the owner's Slack user, open a DM, post.
   * Returns `{ sent: false }` (never throws) when the workspace isn't connected or has no resolvable
   * owner — the #173 Founder Briefings Slack channel reuses this so the brief rides the SAME authority.
   */
  async sendOwnerDm(
    workspaceId: string,
    message: { text: string; blocks?: SlackBlock[] },
  ): Promise<{ sent: boolean }> {
    const secrets = await this.deps.getSecrets(workspaceId);
    if (!secrets) return { sent: false };
    const ownerMemberId = await this.deps.resolveOwner(workspaceId);
    if (!ownerMemberId) return { sent: false };
    const ownerSlackUser = await this.deps.resolveSlackUser(workspaceId, ownerMemberId);
    if (!ownerSlackUser) return { sent: false };
    const dm = await this.deps.client.openDm(secrets.botToken, ownerSlackUser);
    if (!dm) return { sent: false };
    const res = await this.deps.client.postMessage(secrets.botToken, {
      channel: dm.channel,
      text: message.text,
      blocks: message.blocks,
    });
    return { sent: res !== null };
  }
}
