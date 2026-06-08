import { pgTable, uuid, text, integer, bigint, boolean, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";
import { members } from "./identities.js";

/**
 * The audit record for one requested sensitive action (issue #13, ADR-0013).
 *
 * Created when an agent (or member) requests an action; advanced to a terminal status by a human
 * decision, or created already `auto_approved` when the policy does not gate it. `workspace_id` +
 * the reference columns are denormalized so the audit list is a single-table, workspace-scoped read.
 * `action` is the opaque descriptor; `action_summary` is the human-readable preview. A terminal row
 * is immutable — the service only ever updates a row WHERE `status = 'pending'` (the audit guard).
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestedByMemberId: uuid("requested_by_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    actionKind: text("action_kind").notNull(),
    actionSummary: text("action_summary").notNull(),
    action: jsonb("action").notNull().default(sql`'{}'::jsonb`),
    channelId: uuid("channel_id").references(() => channels.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    policyReason: text("policy_reason"),
    decidedByMemberId: uuid("decided_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    decisionReason: text("decision_reason"),
    outcome: text("outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => ({
    byWorkspace: index("approval_requests_workspace_idx").on(t.workspaceId, t.status, t.createdAt),
    byRequester: index("approval_requests_requester_idx").on(t.requestedByMemberId),
    statusCk: check(
      "approval_requests_status_ck",
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'expired', 'auto_approved')`,
    ),
    kindCk: check(
      "approval_requests_kind_ck",
      sql`${t.actionKind} IN ('external_send', 'spend', 'channel_post', 'custom')`,
    ),
  }),
);

/**
 * Per-workspace governance policy (issue #13). One row per workspace (natural key `workspace_id`);
 * defaults are applied in code when no row exists, so an unconfigured workspace still gates external
 * sends + spend. `require_approval_for` and `guarded_channel_ids` are jsonb string arrays.
 */
export const governancePolicies = pgTable("governance_policies", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  spendThresholdCents: integer("spend_threshold_cents").notNull().default(0),
  externalSendRequiresApproval: boolean("external_send_requires_approval").notNull().default(true),
  requireApprovalFor: jsonb("require_approval_for").notNull().default(sql`'[]'::jsonb`),
  guardedChannelIds: jsonb("guarded_channel_ids").notNull().default(sql`'[]'::jsonb`),
  defaultTtlMs: bigint("default_ttl_ms", { mode: "number" }).notNull().default(86_400_000),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
