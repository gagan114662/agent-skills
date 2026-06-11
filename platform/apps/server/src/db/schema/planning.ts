import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Product Planning Loop persistence (#115, ADR-0115). Two workspace-scoped tables:
 *
 *  - `backlog_items` — the durable, RICE-scorable candidate units of work, each sourced from evidence
 *    (`customer_voice` / `growth` / `verifier` / `manual`) with a `source_ref` (the why-ranked-here
 *    link). The pure RICE scorer (`planning/rice.ts`) ranks these; the score is always *derived*, never
 *    persisted, so the routes + the #104 console agree by construction.
 *  - `planning_specs` — the spec drafted for the top-ranked item (repo lifecycle format). Promoting it
 *    to a build session rides the venture-gated #96 launcher; a sensitive item (pivot / over-budget /
 *    not #95-allowed) rides the existing #13 gate (`approval_request_id` links the gated request).
 *
 * `idea_id` / `source_ref` / `target_*` / `spec_id` / `approval_request_id` / `session_id` /
 * `backlog_item_id` are **soft references** (no FK): a venture idea, member, channel, approval, session,
 * or spec may be pruned independently, and the planning record must outlive it. Only `workspace_id`
 * carries the #3 tenant boundary (`onDelete: cascade`).
 */

export const BACKLOG_SOURCES = ["customer_voice", "growth", "verifier", "manual"] as const;
export const BACKLOG_STATUSES = ["proposed", "specced", "dispatched", "done", "rejected"] as const;
export const SPEC_STATUSES = ["draft", "dispatched"] as const;

export const backlogItems = pgTable(
  "backlog_items",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The venture idea (#96) this item belongs to (soft reference), or null for workspace-level. */
    ideaId: uuid("idea_id"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    source: text("source", { enum: BACKLOG_SOURCES }).notNull(),
    /** A link to the evidence (insight id / growth experiment id / verifier result id); the why-ranked-here. */
    sourceRef: text("source_ref").notNull().default(""),
    /** RICE Reach input: distinct corroborating signals. */
    reach: integer("reach").notNull().default(0),
    /** RICE Impact input: gap severity tier 0–4 (scorer maps it to the standard multiplier). */
    impact: integer("impact").notNull().default(0),
    /** RICE Confidence input: corroboration percentage 0–100 (scorer divides by 100). */
    confidencePct: integer("confidence_pct").notNull().default(0),
    /** RICE Effort input: the agent's estimate in points (≥ 1; the denominator). */
    effort: integer("effort").notNull().default(1),
    /** A pivot changes product direction — always a human call in the dispatch decision. */
    isPivot: boolean("is_pivot").notNull().default(false),
    status: text("status", { enum: BACKLOG_STATUSES }).notNull().default("proposed"),
    /** The channel a build session is launched into (soft reference), or null. */
    targetChannelId: uuid("target_channel_id"),
    /** The agent member a build session runs as (soft reference), or null. */
    targetAgentMemberId: uuid("target_agent_member_id"),
    /** The drafted spec (soft reference), or null until the planning tick drafts one. */
    specId: uuid("spec_id"),
    /** The #13 approval request gating this item's dispatch (soft reference), or null. */
    approvalRequestId: uuid("approval_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceStatus: index("backlog_items_workspace_status_idx").on(t.workspaceId, t.status),
    byWorkspaceIdea: index("backlog_items_workspace_idea_idx").on(t.workspaceId, t.ideaId),
    sourceCk: check(
      "backlog_items_source_ck",
      sql`${t.source} IN ('customer_voice','growth','verifier','manual')`,
    ),
    statusCk: check(
      "backlog_items_status_ck",
      sql`${t.status} IN ('proposed','specced','dispatched','done','rejected')`,
    ),
  }),
);

export const planningSpecs = pgTable(
  "planning_specs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The backlog item this spec was drafted for (soft reference). */
    backlogItemId: uuid("backlog_item_id").notNull(),
    title: text("title").notNull(),
    /** The spec body in the repo lifecycle format (markdown). */
    body: text("body").notNull(),
    status: text("status", { enum: SPEC_STATUSES }).notNull().default("draft"),
    /** The proposed build session (soft reference), or null until dispatched. */
    sessionId: uuid("session_id"),
    /** The #13 approval request gating the dispatch (soft reference), or null. */
    approvalRequestId: uuid("approval_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceItem: index("planning_specs_workspace_item_idx").on(t.workspaceId, t.backlogItemId),
    statusCk: check(
      "planning_specs_status_ck",
      sql`${t.status} IN ('draft','dispatched')`,
    ),
  }),
);
