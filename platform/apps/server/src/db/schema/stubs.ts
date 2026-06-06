/**
 * Stub tables — minimal columns + FKs so later issues can extend them via new migrations:
 *   tasks       → #14 (Linear-style task system)
 *   memories    → #15 (typed context/memory graph)
 *   memoryEdges → #15
 *   permissions → #9  (RBAC: read/write/propagate)
 */
import { pgTable, uuid, text, timestamp, jsonb, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: text("status").notNull().default("backlog"),
  assigneeMemberId: uuid("assignee_member_id").references(() => members.id, { onDelete: "set null" }),
  createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memories = pgTable("memories", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  content: jsonb("content").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memoryEdges = pgTable("memory_edges", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  fromMemoryId: uuid("from_memory_id")
    .notNull()
    .references(() => memories.id, { onDelete: "cascade" }),
  toMemoryId: uuid("to_memory_id")
    .notNull()
    .references(() => memories.id, { onDelete: "cascade" }),
  relation: text("relation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * RBAC capability grants (issue #9, ADR-0005). One effective capability level per
 * (member, resource), enforced by the UNIQUE below so grant is an idempotent upsert.
 * Grants always carry a non-null resource_id (the channel id).
 */
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id"),
    capability: text("capability", { enum: ["read", "write", "propagate"] }).notNull(),
    grantedByMemberId: uuid("granted_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    memberResourceUniq: unique("permissions_member_resource_uniq").on(
      t.workspaceId,
      t.memberId,
      t.resourceType,
      t.resourceId,
    ),
  }),
);
