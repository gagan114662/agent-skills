/**
 * Stub tables — minimal columns + FKs so later issues can extend them via new migrations:
 *   tasks       → #14 (Linear-style task system)
 *   memories    → #15 (typed context/memory graph)
 *   memoryEdges → #15
 *   permissions → #9  (RBAC: read/write/propagate)
 */
import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
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

export const permissions = pgTable("permissions", {
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
});
