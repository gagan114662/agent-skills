import { pgTable, uuid, text, timestamp, jsonb, index, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";
import { WORKSPACE_ROLES, INVITE_STATUSES } from "../../team/rbac.js";

/**
 * Governance & trust schema (issue #151, ADR-0151). Three additive tables; no existing table is touched,
 * so a deployment that never enables RBAC/egress keeps today's behavior. number-by-issue prefix `0151_`.
 */

/**
 * Workspace-level role grants (#151). A member's authority over a workspace: `owner > approver > viewer`.
 * One row per (workspace, member) — upserted. Absent ⇒ no role (the default; with RBAC off this means
 * today's "any human member clears", ADR-0151 §3). `granted_by_member_id` is audit (soft).
 */
export const workspaceMemberRoles = pgTable(
  "workspace_member_roles",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    role: text("role", { enum: WORKSPACE_ROLES }).notNull(),
    grantedByMemberId: uuid("granted_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique("workspace_member_roles_uniq").on(t.workspaceId, t.memberId),
    roleCk: check(
      "workspace_member_roles_role_ck",
      sql`${t.role} IN ('viewer','approver','owner')`,
    ),
  }),
);

/**
 * Email invites to a workspace (#151). The raw token is shown to the inviter once and **never stored**;
 * only its sha-256 hash lives here (reuse #68 hashing). Accepting flips `pending → accepted` and creates
 * the member via the existing `createHumanMember({email})` seam. One open invite per (workspace, email).
 */
export const workspaceInvites = pgTable(
  "workspace_invites",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: WORKSPACE_ROLES }).notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status", { enum: INVITE_STATUSES }).notNull().default("pending"),
    invitedByMemberId: uuid("invited_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    acceptedMemberId: uuid("accepted_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => ({
    uniq: unique("workspace_invites_ws_email_uniq").on(t.workspaceId, t.email),
    statusCk: check(
      "workspace_invites_status_ck",
      sql`${t.status} IN ('pending','accepted','revoked')`,
    ),
  }),
);

/**
 * Append-only egress audit (#151). One row per denied/flagged outbound target — the durable
 * flagged-domains report. Mirrors `approval_events`: written in the same path as the decision, never
 * updated or deleted, so the report can never drift from what actually happened. `session_id` /
 * `actor_member_id` are soft (the violation outlives a reaped session or a removed member).
 */
export const egressViolations = pgTable(
  "egress_violations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id"),
    actorMemberId: uuid("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    target: text("target").notNull(),
    domain: text("domain"),
    reason: text("reason").notNull(),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("egress_violations_workspace_created_idx").on(t.workspaceId, t.createdAt),
    byDomain: index("egress_violations_domain_idx").on(t.workspaceId, t.domain),
  }),
);
