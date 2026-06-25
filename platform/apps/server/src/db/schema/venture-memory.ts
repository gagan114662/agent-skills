import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Venture Memory & Planning persistence (#197, ADR-0197). Three workspace-scoped tables. Venture MEMORY
 * itself is NOT here — it reuses the #15 `memories` table tagged `entity = venture:<ideaId>`, `type =
 * venture_memory` (see `venture-memory/memory.ts`). These add the OKRs, the weekly plans, and the
 * cross-venture playbooks.
 *
 * `idea_id` / `approval_request_id` / provenance `verifierResultId` are **soft references** (no FK): a
 * venture idea, an approval, or a verifier result may be pruned independently and these records must
 * outlive them. Only `workspace_id` carries the #3 tenant boundary (`onDelete: cascade`).
 */

export const VENTURE_OKR_STATUSES = ["active", "achieved", "missed", "archived"] as const;
export const VENTURE_PLAN_STATUSES = ["draft", "approved", "rejected", "dispatched"] as const;
export const VENTURE_PLAN_GONOGO = ["go", "no_go"] as const;

/** One key result on an OKR. `verified` (a #106 receipt) is the only thing that lets it read on-track. */
export interface KeyResultRow {
  metric: string;
  target: number;
  current: number;
  unit: string;
  verified: boolean;
  source: string | null;
}

/** One drafted plan item. `estimateLabel` is the literal `UNVERIFIED` (premortem #200, failure mode 2). */
export interface PlanItemRow {
  title: string;
  why: string;
  estimateLabel: "UNVERIFIED";
  source: string;
  sourceRef: string;
  severityTier: number;
  signalCount: number;
  corroboratingSources: number;
  effortPoints: number;
}

/** One provenance entry on a playbook: an anonymized source-venture lineage + the #106 receipt. */
export interface PlaybookProvenanceRow {
  sourceVentureHash: string;
  segment: string | null;
  targetUser: string | null;
  outcome: string;
  evidence: string;
  verifierResultId: string | null;
}

export const ventureOkrs = pgTable(
  "venture_okrs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The venture idea (#96) this objective belongs to (soft reference). */
    ideaId: uuid("idea_id").notNull(),
    objective: text("objective").notNull(),
    keyResults: jsonb("key_results")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<KeyResultRow[]>(),
    status: text("status", { enum: VENTURE_OKR_STATUSES }).notNull().default("active"),
    /** The objective's window label (e.g. a quarter/week). */
    periodKey: text("period_key").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceIdea: index("venture_okrs_workspace_idea_idx").on(t.workspaceId, t.ideaId),
    statusCk: check(
      "venture_okrs_status_ck",
      sql`${t.status} IN ('active','achieved','missed','archived')`,
    ),
  }),
);

export const venturePlans = pgTable(
  "venture_plans",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The venture idea (#96) this plan is for (soft reference). */
    ideaId: uuid("idea_id").notNull(),
    /** ISO week `YYYY-Www`. */
    weekKey: text("week_key").notNull(),
    status: text("status", { enum: VENTURE_PLAN_STATUSES }).notNull().default("draft"),
    /** `no_go` unless the venture has an externally-verified (#106) metric (premortem #200). */
    goNoGo: text("go_no_go", { enum: VENTURE_PLAN_GONOGO }).notNull().default("no_go"),
    /** The go/no-go rationale, citing #200 + the failure modes it answers. */
    rationale: text("rationale").notNull().default(""),
    /** NOT NULL DEFAULT true — the drafter refuses to persist a plan without citing #200. */
    premortemCited: boolean("premortem_cited").notNull().default(true),
    items: jsonb("items")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<PlanItemRow[]>(),
    /** The #13 approval request gating the plan (soft reference), or null until enqueued. */
    approvalRequestId: uuid("approval_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceStatus: index("venture_plans_workspace_status_idx").on(t.workspaceId, t.status),
    weekUk: unique("venture_plans_week_uk").on(t.workspaceId, t.ideaId, t.weekKey),
    statusCk: check(
      "venture_plans_status_ck",
      sql`${t.status} IN ('draft','approved','rejected','dispatched')`,
    ),
    gonogoCk: check("venture_plans_gonogo_ck", sql`${t.goNoGo} IN ('go','no_go')`),
  }),
);

export const venturePlaybooks = pgTable(
  "venture_playbooks",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    category: text("category").notNull().default("general"),
    /** The reusable pattern — anonymized (no venture-identifying text). */
    pattern: text("pattern").notNull(),
    provenance: jsonb("provenance")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<PlaybookProvenanceRow[]>(),
    /** Idempotent distillation handle (one playbook per workspace + dedupe_key). */
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceCategory: index("venture_playbooks_workspace_category_idx").on(
      t.workspaceId,
      t.category,
    ),
    dedupeUk: unique("venture_playbooks_dedupe_uk").on(t.workspaceId, t.dedupeKey),
  }),
);
