/**
 * Stub tables — minimal columns + FKs so later issues can extend them via new migrations:
 *   memories    → #15 (typed context/memory graph)
 *   memoryEdges → #15
 *   permissions → #9  (RBAC: read/write/propagate)
 *
 * `tasks` graduated out of this stub in #14 — it now lives in `schema/tasks.ts`.
 */
import { pgTable, uuid, text, timestamp, jsonb, unique, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";

/**
 * Typed memory/context graph nodes (issue #15, ADR-0015). The #2 stub (id, workspace_id,
 * type, content, created_at) becomes the live node store via 0005_memory:
 *   - `entity` — a normalized subject the node is about (powers query-by-entity)
 *   - `source_type` / `source_id` — provenance: the activity a node was auto-captured from
 *   - `dedupe_key` — deterministic hash of (type, entity, normalized text); the UNIQUE below
 *     makes writes idempotent so obvious duplicates collapse to one node. **Nullable**: #14's
 *     `createMemory()` task-link shim inserts memories without a dedup key (a NULL never
 *     collides under the UNIQUE), while the graph's own writes always supply one.
 * `type` stays free text (extensible); the canonical set is decision/fact/preference/artifact.
 */
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    // plain jsonb (no $type): the #15 graph writes `{ text, ... }`, but #14's createMemory()
    // shim inserts arbitrary content — the precise shape is enforced on the repo functions.
    content: jsonb("content").notNull().default(sql`'{}'::jsonb`),
    entity: text("entity"),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    dedupeKey: text("dedupe_key"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dedupeUniq: unique("memories_workspace_dedupe_uniq").on(t.workspaceId, t.dedupeKey),
    byType: index("memories_workspace_type_idx").on(t.workspaceId, t.type),
    byEntity: index("memories_workspace_entity_idx").on(t.workspaceId, t.entity),
  }),
);

/**
 * Typed, directed edges between memory nodes (same workspace, FK-enforced). `relation` is
 * free text (canonical: relates_to / supports / supersedes / derived_from). The UNIQUE makes
 * an edge idempotent; the per-endpoint indexes serve neighbor traversal.
 */
export const memoryEdges = pgTable(
  "memory_edges",
  {
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
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    edgeUniq: unique("memory_edges_uniq").on(
      t.workspaceId,
      t.fromMemoryId,
      t.toMemoryId,
      t.relation,
    ),
    byFrom: index("memory_edges_from_idx").on(t.fromMemoryId),
    byTo: index("memory_edges_to_idx").on(t.toMemoryId),
  }),
);

/**
 * RBAC capability grants (issue #9, ADR-0009). One effective capability level per
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
