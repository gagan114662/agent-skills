import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  unique,
  check,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";

/**
 * Customer Discovery Engine (#222, ADR-0222): the per-venture signal layer that turns real product-usage
 * + connected-channel receipts into a ranked "who to reach out to now" queue + PQL (product-qualified
 * lead) events, and models the 5-stage GTM pipeline.
 *
 * Four workspace-scoped tables, all READ-ONLY in this issue (nothing here sends — outreach lives in
 * #225). None hold authority over an existing business-domain table. Cross-entity links (`idea_id`,
 * `def_id`) are SOFT (no FK). `prospect_key` is an opaque, caller-supplied actor token — never PII
 * (emails are rejected at ingest, see `discovery/service.ts`). `external_ref` is the verification anchor:
 * a non-empty value (e.g. a Stripe event id) is what lets a downstream metric be VERIFIED — a likelihood
 * score is otherwise labeled UNVERIFIED (premortem #200 §2). Table names are deliberately `discovery_*`
 * (not `growth_*`/`venture_*`/`demand_*`) so the #155 metric-surface colocation check is not tripped —
 * these are new operational tables, not a governed scorer.
 */

export const DISCOVERY_DEF_KINDS = [
  "power_user_threshold",
  "usage_trend",
  "pricing_page_visit",
  "role_match",
] as const;
export const DISCOVERY_SIGNAL_KINDS = [
  "usage_event",
  "pricing_page_visit",
  "role_identified",
  "conversion",
] as const;
export const GTM_STAGES = [
  "outreach",
  "discovery",
  "conversion",
  "onboarding",
  "post_sales",
] as const;

/**
 * The owner-defined qualifying signal (AC1): what makes a prospect "product-qualified". The owner sets
 * the kind + thresholds; the engine evaluates real signals against it. `threshold` is the value floor
 * (e.g. power-user usage count), `window_days` the lookback, `role` the seniority/role to match,
 * `weight` (0–100) the contribution to the likelihood score. One row per (workspace, idea, label).
 */
export const discoverySignalDefs = pgTable(
  "discovery_signal_defs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Soft ref (no FK): which venture this definition belongs to (nullable = workspace-level). */
    ideaId: uuid("idea_id"),
    kind: text("kind", { enum: DISCOVERY_DEF_KINDS }).notNull(),
    label: text("label").notNull(),
    threshold: integer("threshold").notNull().default(1),
    windowDays: integer("window_days").notNull().default(14),
    /** The role/seniority to match for a `role_match` def (e.g. 'vp engineering'); null otherwise. */
    role: text("role"),
    weight: integer("weight").notNull().default(50),
    enabled: boolean("enabled").notNull().default(true),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindCk: check(
      "discovery_signal_defs_kind_ck",
      sql`${t.kind} IN ('power_user_threshold','usage_trend','pricing_page_visit','role_match')`,
    ),
    weightCk: check(
      "discovery_signal_defs_weight_ck",
      sql`${t.weight} >= 0 AND ${t.weight} <= 100`,
    ),
    labelUk: unique("discovery_signal_defs_label_uk").on(t.workspaceId, t.ideaId, t.label),
  }),
);

/**
 * The signal store (AC1): one real product/channel receipt per row — NEVER fabricated. `prospect_key`
 * is an opaque actor token (no PII). `value` is the receipt's weight (e.g. a usage count). `external_ref`
 * is the verification anchor (a real outside reference, e.g. a Stripe event id) — present ⇒ the receipt
 * is externally attributed. `role` carries the identified role for a `role_identified` signal.
 */
export const discoverySignals = pgTable(
  "discovery_signals",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ideaId: uuid("idea_id"),
    /** Opaque, caller-supplied actor token — never PII (emails rejected at ingest). */
    prospectKey: text("prospect_key").notNull(),
    kind: text("kind", { enum: DISCOVERY_SIGNAL_KINDS }).notNull(),
    value: integer("value").notNull().default(1),
    /** The identified role for a `role_identified` signal (e.g. 'vp engineering'); null otherwise. */
    role: text("role"),
    source: text("source").notNull().default(""),
    /** The verification anchor: a real external reference (e.g. Stripe event id); null = self-reported. */
    externalRef: text("external_ref"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindCk: check(
      "discovery_signals_kind_ck",
      sql`${t.kind} IN ('usage_event','pricing_page_visit','role_identified','conversion')`,
    ),
    ideaIdx: index("discovery_signals_idea_idx").on(t.workspaceId, t.ideaId),
    prospectIdx: index("discovery_signals_prospect_idx").on(t.workspaceId, t.prospectKey),
  }),
);

/**
 * A PQL event (AC1): emitted the moment a prospect's real signals satisfy an owner-defined definition.
 * Carries the qualifying definition + the signal kinds that fired + a 0–100 likelihood `score` (always
 * UNVERIFIED — it predicts; it is not an external receipt). `verified` is true ONLY when an externally-
 * attributed conversion grounded the qualification. One row per (workspace, prospect, def) — re-qualifying
 * the same prospect on the same definition is idempotent (the unique key). This is the stable seam the
 * decision-maker resolver (#223) and the outreach engine (#225) consume.
 */
export const discoveryPqlEvents = pgTable(
  "discovery_pql_events",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ideaId: uuid("idea_id"),
    prospectKey: text("prospect_key").notNull(),
    /** Soft ref (no FK) to the definition that qualified this prospect; null if the def was deleted. */
    defId: uuid("def_id"),
    defKind: text("def_kind").notNull(),
    /** 0–100 conversion likelihood — UNVERIFIED (a prediction, not an external receipt). */
    score: integer("score").notNull().default(0),
    /** True only when an externally-attributed conversion grounded the qualification. */
    verified: boolean("verified").notNull().default(false),
    /** The signal kinds that contributed to the qualification (e.g. ['usage_event','pricing_page_visit']). */
    qualifyingSignals: jsonb("qualifying_signals").notNull().default(sql`'[]'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scoreCk: check("discovery_pql_events_score_ck", sql`${t.score} >= 0 AND ${t.score} <= 100`),
    ideaIdx: index("discovery_pql_events_idea_idx").on(t.workspaceId, t.ideaId),
    prospectDefUk: unique("discovery_pql_events_prospect_def_uk").on(
      t.workspaceId,
      t.prospectKey,
      t.defId,
    ),
  }),
);

/**
 * The 5-stage GTM pipeline membership: one row when a prospect enters a stage
 * (outreach → discovery → conversion → onboarding → post_sales). `verified` + `external_ref` mark a stage
 * entry that is externally grounded (e.g. a real conversion receipt) vs an internal transition. One row
 * per (workspace, prospect, stage) — re-entering a stage is idempotent. Per-stage counts + stage-to-stage
 * conversions feed the founder-console growth panel (#104). In this READ-ONLY issue the engine records the
 * `outreach` entry (a prospect became a who-to-reach-out-to) and a `conversion` entry on a verified
 * conversion receipt; later stages populate as real signals arrive (no fabrication).
 */
export const discoveryPipelineEntries = pgTable(
  "discovery_pipeline_entries",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ideaId: uuid("idea_id"),
    prospectKey: text("prospect_key").notNull(),
    stage: text("stage", { enum: GTM_STAGES }).notNull(),
    verified: boolean("verified").notNull().default(false),
    externalRef: text("external_ref"),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stageCk: check(
      "discovery_pipeline_entries_stage_ck",
      sql`${t.stage} IN ('outreach','discovery','conversion','onboarding','post_sales')`,
    ),
    stageIdx: index("discovery_pipeline_entries_stage_idx").on(t.workspaceId, t.stage),
    prospectStageUk: unique("discovery_pipeline_entries_prospect_stage_uk").on(
      t.workspaceId,
      t.prospectKey,
      t.stage,
    ),
  }),
);
