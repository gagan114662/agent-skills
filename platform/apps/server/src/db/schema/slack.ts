import { pgTable, uuid, text, timestamp, unique, index } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";
import { channels } from "./channels.js";
import { messages } from "./messages.js";

/**
 * Slack-native ipop (issue #170, ADR-0170).
 *
 * The per-tenant Slack app connection + the maps that let the fleet work inside the customer's Slack.
 * `workspace_slack_connections.workspace_id` is the PRIMARY KEY — one Slack app per tenant, mirroring
 * the #68 credentials vault (the never-pool invariant). `bot_token` and `signing_secret` are stored
 * **sealed** (AES-256-GCM via `crypto/secretbox` when `AGENT_CREDENTIALS_ENC_KEY` is set) and are NEVER
 * returned by any API — read out only to verify an inbound signature or to post. `bot_token_fingerprint`
 * is a non-reversible hash for the UI's connected state.
 */
export const workspaceSlackConnections = pgTable("workspace_slack_connections", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Sealed Slack bot token (`xoxb-…`). Ciphertext when a key is set; marked pass-through otherwise. */
  botToken: text("bot_token").notNull(),
  /** Sealed Slack signing secret (verifies inbound webhooks). Never returned by an API. */
  signingSecret: text("signing_secret").notNull(),
  /** Non-reversible fingerprint of the bot token for the UI's connected state — never the token. */
  botTokenFingerprint: text("bot_token_fingerprint").notNull(),
  /** The Slack workspace (team) id. */
  teamId: text("team_id"),
  /** The bot's own Slack user id — used to strip `<@BOT>` from an app_mention. */
  botUserId: text("bot_user_id"),
  /** The member who connected it (audit). Soft — survives member deletion. */
  connectedByMemberId: uuid("connected_by_member_id").references(() => members.id, {
    onDelete: "set null",
  }),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Maps a Slack channel to the ipop (platform) channel the fleet works in. One link per Slack channel. */
export const slackChannelLinks = pgTable(
  "slack_channel_links",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slackChannelId: text("slack_channel_id").notNull(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique("slack_channel_links_uniq").on(t.workspaceId, t.slackChannelId),
    byChannel: index("slack_channel_links_channel_idx").on(t.channelId),
  }),
);

/** Maps a Slack user to a platform member so approvals/mentions round-trip to a real identity. */
export const slackUserLinks = pgTable(
  "slack_user_links",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slackUserId: text("slack_user_id").notNull(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique("slack_user_links_uniq").on(t.workspaceId, t.slackUserId),
  }),
);

/**
 * Maps a platform thread root (the @mention message) to its Slack thread so the agent's reply posts
 * back in the same Slack thread the human started.
 */
export const slackThreadLinks = pgTable(
  "slack_thread_links",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    rootMessageId: uuid("root_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    slackChannelId: text("slack_channel_id").notNull(),
    slackThreadTs: text("slack_thread_ts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique("slack_thread_links_uniq").on(t.workspaceId, t.rootMessageId),
    byRoot: index("slack_thread_links_workspace_root_idx").on(t.workspaceId, t.rootMessageId),
  }),
);

/** Append-only dedupe ledger: one row per processed Slack event id (Slack retries deliveries). */
export const slackEventsSeen = pgTable(
  "slack_events_seen",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slackEventId: text("slack_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique("slack_events_seen_uniq").on(t.workspaceId, t.slackEventId),
  }),
);
