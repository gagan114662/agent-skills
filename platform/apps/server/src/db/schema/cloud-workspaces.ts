import { pgTable, uuid, text, boolean, timestamp, index, check, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";

/**
 * A durable cloud filesystem environment within a tenant (issue #55, ADR-0032).
 *
 * Builds on #25: a session snapshots its filesystem at teardown. A cloud workspace OUTLIVES any
 * single session — it retains the latest `snapshotId` (the wake/resume key), can be slept to save
 * resources and woken to resume, mirrors its files to a local directory (with `setupCompleted`
 * gating a one-time setup), and can be shared with scoped, revocable collaborators. The
 * `created_by` member is the owner (implicit admin). `lastActiveAt` drives the idle sweep.
 */
export const cloudWorkspaces = pgTable(
  "cloud_workspaces",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "sleeping", "archived"] })
      .notNull()
      .default("active"),
    snapshotId: text("snapshot_id"),
    setupCompleted: boolean("setup_completed").notNull().default(false),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("cloud_workspaces_workspace_idx").on(t.workspaceId),
    byStatus: index("cloud_workspaces_status_idx").on(t.status, t.lastActiveAt),
    statusCk: check(
      "cloud_workspaces_status_ck",
      sql`${t.status} IN ('active', 'sleeping', 'archived')`,
    ),
  }),
);

/**
 * Scoped, revocable collaborator access on a cloud workspace (#9 RBAC ladder). The owner holds
 * `propagate` implicitly (no row). `revokedAt IS NULL` = active; setting it cuts access at once
 * while keeping the audit trail. One row per (workspace, member) — re-inviting upserts.
 */
export const cloudWorkspaceCollaborators = pgTable(
  "cloud_workspace_collaborators",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    cloudWorkspaceId: uuid("cloud_workspace_id")
      .notNull()
      .references(() => cloudWorkspaces.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    capability: text("capability", { enum: ["read", "write", "propagate"] }).notNull(),
    grantedByMemberId: uuid("granted_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    byMember: index("cloud_ws_collab_member_idx").on(t.memberId),
    capabilityCk: check(
      "cloud_ws_collab_capability_ck",
      sql`${t.capability} IN ('read', 'write', 'propagate')`,
    ),
    uniqueMember: unique("cloud_ws_collab_unique").on(t.cloudWorkspaceId, t.memberId),
  }),
);
