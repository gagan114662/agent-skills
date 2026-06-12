import { and, eq } from "drizzle-orm";
import { db } from "../index.js";
import {
  workspaceSlackConnections,
  slackChannelLinks,
  slackUserLinks,
  slackThreadLinks,
  slackEventsSeen,
} from "../schema/index.js";
import { seal, open, tokenFingerprint, loadEncKey } from "../../crypto/secretbox.js";

/**
 * Per-tenant Slack connection vault + the maps that bridge ipop ↔ Slack (#170, ADR-0170).
 *
 * Mirrors the #68 credentials repo: connecting stores the bot token AND signing secret SEALED
 * (encrypted at rest when `AGENT_CREDENTIALS_ENC_KEY` is set) + a non-reversible fingerprint. The
 * secrets are read back ONLY to verify an inbound signature or to post — `getSlackStatus` deliberately
 * never returns them, so a status API can't leak them. Every read is keyed by `workspaceId`, so a
 * connection is strictly scoped to its own tenant (one Slack app per workspace — the never-pool
 * invariant; `workspace_id` is the table's primary key).
 */

/** What the Settings UI is allowed to know — never the tokens themselves. */
export interface SlackStatus {
  connected: boolean;
  fingerprint: string | null;
  teamId: string | null;
  connectedAt: Date | null;
}

/** The decrypted secrets, read out only by the signature verifier + the poster. */
export interface SlackSecrets {
  botToken: string;
  signingSecret: string;
  botUserId: string | null;
  teamId: string | null;
}

/** Connect (or re-connect) a workspace's Slack app. Last write wins. */
export async function setSlackConnection(input: {
  workspaceId: string;
  botToken: string;
  signingSecret: string;
  teamId?: string | null;
  botUserId?: string | null;
  connectedByMemberId?: string | null;
}): Promise<SlackStatus> {
  const key = loadEncKey();
  const sealedToken = seal(input.botToken, key);
  const sealedSecret = seal(input.signingSecret, key);
  const fingerprint = tokenFingerprint(input.botToken);
  const now = new Date();
  await db
    .insert(workspaceSlackConnections)
    .values({
      workspaceId: input.workspaceId,
      botToken: sealedToken,
      signingSecret: sealedSecret,
      botTokenFingerprint: fingerprint,
      teamId: input.teamId ?? null,
      botUserId: input.botUserId ?? null,
      connectedByMemberId: input.connectedByMemberId ?? null,
      connectedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceSlackConnections.workspaceId,
      set: {
        botToken: sealedToken,
        signingSecret: sealedSecret,
        botTokenFingerprint: fingerprint,
        teamId: input.teamId ?? null,
        botUserId: input.botUserId ?? null,
        connectedByMemberId: input.connectedByMemberId ?? null,
        updatedAt: now,
      },
    });
  return { connected: true, fingerprint, teamId: input.teamId ?? null, connectedAt: now };
}

/** Resolve a workspace's decrypted Slack secrets, or null when not connected. Internal use only. */
export async function getSlackSecrets(workspaceId: string): Promise<SlackSecrets | null> {
  const [row] = await db
    .select({
      botToken: workspaceSlackConnections.botToken,
      signingSecret: workspaceSlackConnections.signingSecret,
      botUserId: workspaceSlackConnections.botUserId,
      teamId: workspaceSlackConnections.teamId,
    })
    .from(workspaceSlackConnections)
    .where(eq(workspaceSlackConnections.workspaceId, workspaceId))
    .limit(1);
  if (!row) return null;
  const key = loadEncKey();
  return {
    botToken: open(row.botToken, key),
    signingSecret: open(row.signingSecret, key),
    botUserId: row.botUserId,
    teamId: row.teamId,
  };
}

/** The connected/not-connected state for the Settings UI — never exposes the secrets. */
export async function getSlackStatus(workspaceId: string): Promise<SlackStatus> {
  const [row] = await db
    .select({
      fingerprint: workspaceSlackConnections.botTokenFingerprint,
      teamId: workspaceSlackConnections.teamId,
      connectedAt: workspaceSlackConnections.connectedAt,
    })
    .from(workspaceSlackConnections)
    .where(eq(workspaceSlackConnections.workspaceId, workspaceId))
    .limit(1);
  if (!row) return { connected: false, fingerprint: null, teamId: null, connectedAt: null };
  return {
    connected: true,
    fingerprint: row.fingerprint,
    teamId: row.teamId,
    connectedAt: row.connectedAt,
  };
}

/** Disconnect a workspace's Slack app (idempotent). The cascade clears its links. */
export async function clearSlackConnection(workspaceId: string): Promise<void> {
  await db
    .delete(workspaceSlackConnections)
    .where(eq(workspaceSlackConnections.workspaceId, workspaceId));
}

// --- channel ↔ channel links -------------------------------------------------------------------

/** Link a Slack channel to a platform channel (idempotent upsert). */
export async function linkSlackChannel(input: {
  workspaceId: string;
  slackChannelId: string;
  channelId: string;
}): Promise<void> {
  await db
    .insert(slackChannelLinks)
    .values(input)
    .onConflictDoUpdate({
      target: [slackChannelLinks.workspaceId, slackChannelLinks.slackChannelId],
      set: { channelId: input.channelId },
    });
}

/** Resolve the platform channel a Slack channel is linked to, or null. */
export async function getChannelForSlackChannel(
  workspaceId: string,
  slackChannelId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ channelId: slackChannelLinks.channelId })
    .from(slackChannelLinks)
    .where(
      and(
        eq(slackChannelLinks.workspaceId, workspaceId),
        eq(slackChannelLinks.slackChannelId, slackChannelId),
      ),
    )
    .limit(1);
  return row?.channelId ?? null;
}

// --- user ↔ member links -----------------------------------------------------------------------

/** Link a Slack user to a platform member (idempotent upsert). */
export async function linkSlackUser(input: {
  workspaceId: string;
  slackUserId: string;
  memberId: string;
}): Promise<void> {
  await db
    .insert(slackUserLinks)
    .values(input)
    .onConflictDoUpdate({
      target: [slackUserLinks.workspaceId, slackUserLinks.slackUserId],
      set: { memberId: input.memberId },
    });
}

/** Resolve the platform member a Slack user is linked to, or null. */
export async function getMemberForSlackUser(
  workspaceId: string,
  slackUserId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ memberId: slackUserLinks.memberId })
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.workspaceId, workspaceId),
        eq(slackUserLinks.slackUserId, slackUserId),
      ),
    )
    .limit(1);
  return row?.memberId ?? null;
}

/** Resolve the Slack user id linked to a platform member (for DM addressing), or null. */
export async function getSlackUserForMember(
  workspaceId: string,
  memberId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ slackUserId: slackUserLinks.slackUserId })
    .from(slackUserLinks)
    .where(
      and(eq(slackUserLinks.workspaceId, workspaceId), eq(slackUserLinks.memberId, memberId)),
    )
    .limit(1);
  return row?.slackUserId ?? null;
}

// --- thread links (mention root → Slack thread) ------------------------------------------------

/** Record the Slack thread an @mention message belongs to so agent replies post back to it. */
export async function linkSlackThread(input: {
  workspaceId: string;
  rootMessageId: string;
  slackChannelId: string;
  slackThreadTs: string;
}): Promise<void> {
  await db
    .insert(slackThreadLinks)
    .values(input)
    .onConflictDoUpdate({
      target: [slackThreadLinks.workspaceId, slackThreadLinks.rootMessageId],
      set: { slackChannelId: input.slackChannelId, slackThreadTs: input.slackThreadTs },
    });
}

/** Resolve the Slack thread a platform thread root maps to, or null. */
export async function getSlackThreadForRoot(
  workspaceId: string,
  rootMessageId: string,
): Promise<{ slackChannelId: string; slackThreadTs: string } | null> {
  const [row] = await db
    .select({
      slackChannelId: slackThreadLinks.slackChannelId,
      slackThreadTs: slackThreadLinks.slackThreadTs,
    })
    .from(slackThreadLinks)
    .where(
      and(
        eq(slackThreadLinks.workspaceId, workspaceId),
        eq(slackThreadLinks.rootMessageId, rootMessageId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// --- event dedupe ------------------------------------------------------------------------------

/**
 * Record a Slack event id as processed. Returns true if this is the FIRST time we've seen it (caller
 * should process), false if it's a duplicate retry (caller should skip). Append-only.
 */
export async function markSlackEventSeen(
  workspaceId: string,
  slackEventId: string,
): Promise<boolean> {
  const inserted = await db
    .insert(slackEventsSeen)
    .values({ workspaceId, slackEventId })
    .onConflictDoNothing({
      target: [slackEventsSeen.workspaceId, slackEventsSeen.slackEventId],
    })
    .returning({ id: slackEventsSeen.id });
  return inserted.length > 0;
}
