import type { FastifyBaseLogger } from "fastify";
import type { Identity } from "../auth/identity.js";
import type { Channel } from "../db/repositories/channels.js";
import type { Message } from "../db/repositories/messages.js";
import { listChannelMemberIds } from "../db/repositories/channels.js";
import { resolveAndPersistMentions } from "../db/repositories/mentions.js";
import { publishMessageEvent, publishMention } from "../realtime/bus.js";
import { notify } from "../notifications/service.js";
import { mirrorExternalRoomPost, type ExternalRoomMirrorSource } from "./external-room-mirror.js";

/**
 * Side-effect fan-out for a freshly-persisted message, factored out of the #4 channel routes so the
 * **same** delivery runs whether a message is posted over REST (`routes/channels.ts`) or over the
 * #10 MCP `post_message` / `reply_thread` tools. REST stays the source of truth; everything here is
 * best-effort (a Redis/notify hiccup is logged, never failing the write that already succeeded):
 *   - realtime broadcast to the channel (#5) — this is what makes a message appear live in the web UI;
 *   - @mention resolution → realtime `mention` push (#6) + durable notification (#8);
 *   - DM / thread-reply notifications (#8);
 *   - the #123 marketing @mention → real-session trigger (registered at boot — see below).
 */

/**
 * The #123 marketing @mention → real-session trigger, registered once at app boot via
 * {@link setMarketingMentionTrigger}. This is the wire that turns a plain `@scout …` post in a
 * department channel into a launched session: WITHOUT it, the launch only ran via the standalone
 * `POST /channels/:cid/messages/:mid/marketing` endpoint that no client ever calls, so a real
 * @mention silently did nothing (`sessionsStarted` stayed 0). It lives here, in the shared fan-out,
 * so every post path (REST + MCP) triggers it through one seam. It does its OWN gating (human author,
 * marketing channel, mentioned persona) and is invoked best-effort — a launch denial (kill switch /
 * budget) or any error is logged, never failing the message write that already succeeded.
 */
export type MarketingMentionTrigger = (
  identity: Identity,
  channel: Channel,
  message: Message,
) => Promise<void>;

let marketingMentionTrigger: MarketingMentionTrigger | undefined;

/** Register (or clear, with `undefined`) the marketing @mention trigger. Called from `buildApp`. */
export function setMarketingMentionTrigger(fn: MarketingMentionTrigger | undefined): void {
  marketingMentionTrigger = fn;
}

/** Run the registered marketing trigger for a just-posted message, best-effort. No-op when unset. */
async function fireMarketingMention(
  log: FastifyBaseLogger,
  identity: Identity,
  channel: Channel,
  message: Message,
): Promise<void> {
  if (!marketingMentionTrigger) return;
  try {
    await marketingMentionTrigger(identity, channel, message);
  } catch (err) {
    // A kill-switch/budget denial (AdmissionError) or any failure must not fail the write — the
    // safety property (no session launched) still holds; we only lose the launch, which we log.
    log.error({ err }, "marketing @mention launch failed");
  }
}

export function externalRoomSourceForIdentity(
  identity: Pick<Identity, "kind">,
  fallback: Exclude<ExternalRoomMirrorSource, "agent_post">,
): ExternalRoomMirrorSource {
  return identity.kind === "agent" ? "agent_post" : fallback;
}

/**
 * Derive @mentions from a just-posted message, persist them, and push a realtime `mention` plus a
 * durable notification to each mentioned member (#6/#8). Best-effort; never throws.
 */
export async function fanOutMentions(
  log: FastifyBaseLogger,
  identity: Identity,
  message: Message,
): Promise<void> {
  try {
    const mentions = await resolveAndPersistMentions({
      workspaceId: identity.workspaceId,
      channelId: message.channelId,
      messageId: message.id,
      authorMemberId: identity.memberId,
      body: message.body,
    });
    for (const m of mentions) {
      publishMention(identity.workspaceId, {
        id: m.id,
        messageId: m.messageId,
        channelId: m.channelId,
        mentionedMemberId: m.mentionedMemberId,
        authorMemberId: m.authorMemberId,
        body: m.body,
      }).catch((err) => log.error({ err }, "mention publish failed"));
      // #8: a mention is also a durable notification (inbox + unread), on top of the #6 event.
      await notify(log, {
        workspaceId: identity.workspaceId,
        recipientMemberId: m.mentionedMemberId,
        type: "mention",
        actorMemberId: m.authorMemberId,
        channelId: m.channelId,
        messageId: m.messageId,
        excerpt: m.body,
      });
    }
  } catch (err) {
    log.error({ err }, "mention extraction failed");
  }
}

/**
 * Notify the *other* members of a DM that a message landed (#8). No-op for non-DM channels and for
 * the author. Best-effort: `notify` never throws, so this can't fail the write.
 */
export async function notifyDmRecipients(
  log: FastifyBaseLogger,
  identity: Identity,
  channel: Channel,
  message: Message,
): Promise<void> {
  if (channel.kind !== "dm") return;
  const memberIds = await listChannelMemberIds(channel.id);
  for (const recipientMemberId of memberIds) {
    if (recipientMemberId === identity.memberId) continue;
    await notify(log, {
      workspaceId: identity.workspaceId,
      recipientMemberId,
      type: "dm",
      actorMemberId: identity.memberId,
      channelId: channel.id,
      messageId: message.id,
      excerpt: message.body,
    });
  }
}

/**
 * Full delivery for a top-level channel post: realtime broadcast (#5) + mention fan-out (#6/#8) +
 * DM notifications (#8). Used by `POST /channels/:cid/messages` and the MCP `post_message` tool.
 */
export async function deliverPostedMessage(
  log: FastifyBaseLogger,
  identity: Identity,
  channel: Channel,
  message: Message,
): Promise<void> {
  publishMessageEvent(channel.id, message).catch((err) =>
    log.error({ err }, "realtime publish failed"),
  );
  await fanOutMentions(log, identity, message);
  await notifyDmRecipients(log, identity, channel, message);
  // #123: a top-level @mention of a department agent in its channel launches a real session.
  await fireMarketingMention(log, identity, channel, message);
  await mirrorExternalRoomPost(log, {
    workspaceId: identity.workspaceId,
    channelId: channel.id,
    message,
    author: identity.displayName,
    source: externalRoomSourceForIdentity(identity, "room_message"),
  });
}

/**
 * Full delivery for a threaded reply: realtime broadcast (#5) + mention fan-out (#6/#8) + a `reply`
 * notification to the thread root's author (#8; `notify` no-ops if the replier is the root author).
 * Used by `POST /channels/:cid/messages/:mid/replies` and the MCP `reply_thread` tool.
 */
export async function deliverThreadReply(
  log: FastifyBaseLogger,
  identity: Identity,
  channel: Channel,
  message: Message,
  rootAuthorMemberId: string,
): Promise<void> {
  publishMessageEvent(channel.id, message).catch((err) =>
    log.error({ err }, "realtime publish failed"),
  );
  await fanOutMentions(log, identity, message);
  await notify(log, {
    workspaceId: identity.workspaceId,
    recipientMemberId: rootAuthorMemberId,
    type: "reply",
    actorMemberId: identity.memberId,
    channelId: channel.id,
    messageId: message.id,
    excerpt: message.body,
  });
  await mirrorExternalRoomPost(log, {
    workspaceId: identity.workspaceId,
    channelId: channel.id,
    message,
    author: identity.displayName,
    source: externalRoomSourceForIdentity(identity, "thread_reply"),
  });
}
