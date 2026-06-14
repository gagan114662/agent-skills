import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";
import type { CandidateSourceKind, CandidateStatus, EdgeClaim, ValidationReceipt, ValidationVerdict } from "../../venture-factory/types.js";

/**
 * Venture Factory tables (#187, ADR-0187): the idea → validated → launched pipeline. Numbered 0187 by
 * ISSUE (per ADR-0099, to dodge sibling-workspace collisions). Tenant boundary: `workspace_id` (#3,
 * onDelete cascade). `candidate_id` cascades (same migration). Cross-entity links to the #96 idea and
 * the #13 approval are **soft references** (no FK), matching the #197 persistence discipline — a record
 * outlives a pruned idea/approval. The pure decision math lives in `venture-factory/*.ts`; these tables
 * are persistence only.
 */

export const CANDIDATE_SOURCES_DB = ["lens", "scout", "owner"] as const;
export const CANDIDATE_STATUSES_DB = [
  "scanned",
  "validating",
  "validated",
  "bootstrap_pending",
  "launched",
  "killed",
] as const;
export const EDGE_STATUSES_DB = ["unevaluated", "qualified", "rejected"] as const;
export const VALIDATION_VERDICTS_DB = ["PROMOTE", "KILL", "INCONCLUSIVE"] as const;
export const VALIDATION_STATUSES_DB = ["running", "concluded"] as const;
export const FACTORY_VENTURE_STATUSES_DB = ["launching", "launched", "archived"] as const;

/** A scored opportunity candidate filed by the scanner, with its evidence + edge claims. */
export const factoryCandidates = pgTable(
  "factory_candidates",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    source: text("source", { enum: CANDIDATE_SOURCES_DB }).$type<CandidateSourceKind>().notNull(),
    thesis: text("thesis").notNull(),
    proposedName: text("proposed_name").notNull(),
    painIntensity: integer("pain_intensity").notNull(),
    competitionAbsence: integer("competition_absence").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    citations: jsonb("citations").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** 0–100 multiplicative opportunity score (`scoreCandidate`). */
    score: integer("score").notNull(),
    edgeClaims: jsonb("edge_claims").$type<EdgeClaim[]>().notNull().default(sql`'[]'::jsonb`),
    /** The edge gate verdict (`unevaluated` until `decideEdgeGate` runs at validation). */
    edgeStatus: text("edge_status", { enum: EDGE_STATUSES_DB }).notNull().default("unevaluated"),
    status: text("status", { enum: CANDIDATE_STATUSES_DB }).$type<CandidateStatus>().notNull().default("scanned"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStatus: index("factory_candidates_workspace_status_idx").on(t.workspaceId, t.status),
    byScore: index("factory_candidates_workspace_score_idx").on(t.workspaceId, t.score),
    byCreated: index("factory_candidates_workspace_created_idx").on(t.workspaceId, t.createdAt),
    sourceCk: check("factory_candidates_source_ck", sql`${t.source} IN ('lens','scout','owner')`),
    edgeStatusCk: check(
      "factory_candidates_edge_status_ck",
      sql`${t.edgeStatus} IN ('unevaluated','qualified','rejected')`,
    ),
    statusCk: check(
      "factory_candidates_status_ck",
      sql`${t.status} IN ('scanned','validating','validated','bootstrap_pending','launched','killed')`,
    ),
  }),
);

/** One validation experiment per candidate (smoke test) — the external receipts + derived scorecard. */
export const factoryValidations = pgTable(
  "factory_validations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => factoryCandidates.id, { onDelete: "cascade" }),
    /** The HARD validation budget cap (cents) — spend may never exceed this. */
    budgetCapCents: integer("budget_cap_cents").notNull(),
    spentCents: integer("spent_cents").notNull().default(0),
    signups: integer("signups").notNull().default(0),
    /** CAC (cents) = spend ÷ signups; null at zero signups. UNVERIFIED (derived). */
    cacCents: integer("cac_cents"),
    /** 0–100 derived validation score. UNVERIFIED — never kills/scales alone (FM#2). */
    score: integer("score").notNull().default(0),
    verdict: text("verdict", { enum: VALIDATION_VERDICTS_DB }).$type<ValidationVerdict>(),
    status: text("status", { enum: VALIDATION_STATUSES_DB }).notNull().default("running"),
    /** The external receipts (signed signups / ad-spend records) the scorecard is built from. */
    receipts: jsonb("receipts").$type<ValidationReceipt[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCandidate: unique("factory_validations_candidate_uk").on(t.workspaceId, t.candidateId),
    byStatus: index("factory_validations_workspace_status_idx").on(t.workspaceId, t.status),
    verdictCk: check(
      "factory_validations_verdict_ck",
      sql`${t.verdict} IS NULL OR ${t.verdict} IN ('PROMOTE','KILL','INCONCLUSIVE')`,
    ),
    statusCk: check("factory_validations_status_ck", sql`${t.status} IN ('running','concluded')`),
  }),
);

/** A bootstrapped, live venture — idempotent, one per candidate. */
export const factoryVentures = pgTable(
  "factory_ventures",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => factoryCandidates.id, { onDelete: "cascade" }),
    /** Soft ref to the #96 venture idea this became (null until linked). No FK (record outlives prune). */
    ventureIdeaId: uuid("venture_idea_id"),
    name: text("name").notNull(),
    status: text("status", { enum: FACTORY_VENTURE_STATUSES_DB }).notNull().default("launching"),
    /** Soft ref to the `venture.bootstrap` #13 gate, or null. */
    approvalRequestId: uuid("approval_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    byCandidate: unique("factory_ventures_candidate_uk").on(t.workspaceId, t.candidateId),
    byStatus: index("factory_ventures_workspace_status_idx").on(t.workspaceId, t.status),
    statusCk: check(
      "factory_ventures_status_ck",
      sql`${t.status} IN ('launching','launched','archived')`,
    ),
  }),
);
