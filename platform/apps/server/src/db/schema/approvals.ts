import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  doublePrecision,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";
import { APPROVAL_STATUSES } from "../../approvals/policy.js";

/**
 * Human approval gates & governance (issue #13, ADR-0013). Three additive tables; no existing table
 * is touched. A member submits an action; the policy engine decides whether it pauses here.
 */

/**
 * Per-workspace policy rules: which action types pause for a human. `require_approval` gates a type
 * outright; `max_auto_amount` (when set) re-gates a spend above the threshold. One rule per
 * (workspace, action_type) — upserted. No rule for a type → the `DEFAULT_SENSITIVE_ACTIONS` fallback.
 */
export const approvalPolicies = pgTable(
  "approval_policies",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(),
    requireApproval: boolean("require_approval").notNull().default(true),
    maxAutoAmount: doublePrecision("max_auto_amount"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique("approval_policies_uniq").on(t.workspaceId, t.actionType),
  }),
);

/**
 * A gated action awaiting (or having received) a human decision. `payload` is the full action
 * descriptor re-passed to the executor; `summary` snapshots it for the review queue / inbox.
 * `status` walks the ADR-0013 lifecycle; `expires_at` is the lazy-expiry deadline.
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requesterMemberId: uuid("requester_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    amount: doublePrecision("amount"),
    summary: text("summary").notNull(),
    status: text("status", { enum: APPROVAL_STATUSES }).notNull().default("pending"),
    reason: text("reason"),
    decidedByMemberId: uuid("decided_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    expiresAtTimezone: text("expires_at_timezone").notNull().default("UTC"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStatus: index("approval_requests_workspace_status_idx").on(t.workspaceId, t.status),
    statusCk: check(
      "approval_requests_status_ck",
      sql`${t.status} IN ('pending','approved','executed','failed','rejected','expired')`,
    ),
  }),
);

/**
 * Append-only audit of everything that happens to a request (ADR-0013 §7). Written in the same
 * transaction as the mutation, so the log can never drift from state. Never updated or deleted.
 */
export const APPROVAL_EVENT_TYPES = [
  "requested",
  "approved",
  "rejected",
  "expired",
  "executed",
  "failed",
] as const;

export const approvalEvents = pgTable(
  "approval_events",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestId: uuid("request_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    type: text("type", { enum: APPROVAL_EVENT_TYPES }).notNull(),
    actorMemberId: uuid("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRequest: index("approval_events_request_created_idx").on(t.requestId, t.createdAt),
  }),
);
