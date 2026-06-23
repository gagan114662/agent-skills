import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Growth Loop persistence (#102, ADR-0102). Two workspace-scoped tables:
 *
 *  - `growth_events` — the append-only distribution instrumentation log. One row per growth event
 *    (acquisition / activation / conversion / retention, tagged with a traffic source); the pure
 *    funnel scorer (`growth/score.ts`) aggregates these into the venture's score.
 *  - `growth_experiments` — the channel-experiment ledger: experiments proposed by the marketing fleet
 *    (#123). Promoting one to an external post rides the existing `external.send` #13 gate (the
 *    `approval_request_id` links the gated request); agents never publish autonomously.
 *
 * `idea_id` / `proposed_by_member_id` / `approval_request_id` are **soft references** (no FK): a venture
 * idea, agent member, or approval row may be pruned independently, and the growth record must outlive
 * it. Only `workspace_id` carries the #3 tenant boundary (`onDelete: cascade`).
 */

export const GROWTH_EVENT_KINDS = ["acquisition", "activation", "conversion", "retention"] as const;

export const growthEvents = pgTable(
  "growth_events",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The venture idea (#96) this event belongs to (soft reference), or null for workspace-level. */
    ideaId: uuid("idea_id"),
    kind: text("kind", { enum: GROWTH_EVENT_KINDS }).notNull(),
    /** The traffic/attribution source (e.g. `producthunt`, `organic`); `''` when unattributed. */
    source: text("source").notNull().default(""),
    /** The count/weight this event carries (default 1); negative weights are ignored by the funnel. */
    value: integer("value").notNull().default(1),
    /** Free-form drill-down bag (path, campaign, variant) — never aggregated. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceIdea: index("growth_events_workspace_idea_idx").on(t.workspaceId, t.ideaId),
    byWorkspaceKind: index("growth_events_workspace_kind_idx").on(t.workspaceId, t.kind),
    kindCk: check(
      "growth_events_kind_ck",
      sql`${t.kind} IN ('acquisition','activation','conversion','retention')`,
    ),
  }),
);

export const EXPERIMENT_STATUSES = [
  "proposed",
  "approved",
  "running",
  "paused",
  "completed",
  "abandoned",
] as const;

export const growthExperiments = pgTable(
  "growth_experiments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The venture idea (#96) this experiment promotes (soft reference), or null. */
    ideaId: uuid("idea_id"),
    channel: text("channel").notNull(),
    hypothesis: text("hypothesis").notNull(),
    variant: text("variant").notNull().default(""),
    metricKey: text("metric_key").notNull().default(""),
    /** The content engine's measurable target query (e.g. a keyword to rank for); `''` when none. */
    targetQuery: text("target_query").notNull().default(""),
    status: text("status", { enum: EXPERIMENT_STATUSES }).notNull().default("proposed"),
    /** The marketing agent member that proposed it (soft reference), or null. */
    proposedByMemberId: uuid("proposed_by_member_id"),
    /** The #13 approval request gating an external post for this experiment (soft reference), or null. */
    approvalRequestId: uuid("approval_request_id"),
    resultSummary: text("result_summary").notNull().default(""),
    result: text("result").notNull().default(""),
    decision: text("decision").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceStatus: index("growth_experiments_workspace_status_idx").on(t.workspaceId, t.status),
    statusCk: check(
      "growth_experiments_status_ck",
      sql`${t.status} IN ('proposed','approved','running','paused','completed','abandoned')`,
    ),
  }),
);
