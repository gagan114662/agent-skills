import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";
import { ventureIdeas } from "./venture.js";

/**
 * Insight Miner persistence (#100, ADR-0100). Three workspace-scoped tables feeding the Venture Loop
 * (#96) SOURCE stage: the ranked candidate source list (the "list is the strategy" surface), the
 * structured mined insight, and the provenance trail (source URLs + recency). All `workspace_id`-scoped
 * with `onDelete: cascade` (the #3 tenant boundary).
 */

/** The asymmetry classes a candidate source can carry. */
export const INSIGHT_SOURCE_KINDS = [
  "community",
  "reviews",
  "support_forum",
  "api_changelog",
  "regulation",
  "pricing",
  "model_capability",
  "owner_secret",
] as const;

export const INSIGHT_SOURCE_STATUSES = ["candidate", "mined", "skipped"] as const;

/** The three insight kinds: cited pain, a why-now delta, or the owner's proprietary secret. */
export const INSIGHT_KINDS = ["pain", "why_now", "owner_secret"] as const;

export const INSIGHT_STATUSES = ["mined", "promoted", "killed", "duplicate"] as const;

/** The candidate source list, scored by evidence strength BEFORE mining ("list is the strategy"). */
export const insightSources = pgTable(
  "insight_sources",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: INSIGHT_SOURCE_KINDS }).notNull(),
    url: text("url"),
    title: text("title").notNull().default(""),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    evidenceStrength: integer("evidence_strength").notNull().default(0),
    status: text("status", { enum: INSIGHT_SOURCE_STATUSES }).notNull().default("candidate"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStatus: index("insight_sources_workspace_status_idx").on(t.workspaceId, t.status),
    byStrength: index("insight_sources_workspace_strength_idx").on(t.workspaceId, t.evidenceStrength),
    kindCk: check(
      "insight_sources_kind_ck",
      sql`${t.kind} IN ('community','reviews','support_forum','api_changelog','regulation','pricing','model_capability','owner_secret')`,
    ),
    statusCk: check(
      "insight_sources_status_ck",
      sql`${t.status} IN ('candidate','mined','skipped')`,
    ),
  }),
);

/** The structured mined insight: ranks by freshness × pain_intensity × competition_absence. */
export const insights = pgTable(
  "insights",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: INSIGHT_KINDS }).notNull(),
    statement: text("statement").notNull(),
    painIntensity: integer("pain_intensity").notNull().default(0),
    competitionAbsence: integer("competition_absence").notNull().default(0),
    freshnessAt: timestamp("freshness_at", { withTimezone: true }).notNull().defaultNow(),
    score: integer("score").notNull().default(0),
    status: text("status", { enum: INSIGHT_STATUSES }).notNull().default("mined"),
    dedupeKey: text("dedupe_key").notNull(),
    promotedIdeaId: uuid("promoted_idea_id").references(() => ventureIdeas.id, {
      onDelete: "set null",
    }),
    sourceId: uuid("source_id").references(() => insightSources.id, { onDelete: "set null" }),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStatus: index("insights_workspace_status_idx").on(t.workspaceId, t.status),
    byScore: index("insights_workspace_score_idx").on(t.workspaceId, t.score),
    byDedupe: index("insights_workspace_dedupe_idx").on(t.workspaceId, t.dedupeKey),
    kindCk: check("insights_kind_ck", sql`${t.kind} IN ('pain','why_now','owner_secret')`),
    statusCk: check(
      "insights_status_ck",
      sql`${t.status} IN ('mined','promoted','killed','duplicate')`,
    ),
    painCk: check("insights_pain_ck", sql`${t.painIntensity} BETWEEN 0 AND 10`),
    competitionCk: check("insights_competition_ck", sql`${t.competitionAbsence} BETWEEN 0 AND 10`),
  }),
);

/** The provenance trail: every insight carries source URLs + recency (one row per cited claim). */
export const insightEvidence = pgTable(
  "insight_evidence",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    insightId: uuid("insight_id")
      .notNull()
      .references(() => insights.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url"),
    excerpt: text("excerpt").notNull().default(""),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    sourceId: uuid("source_id").references(() => insightSources.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byInsight: index("insight_evidence_workspace_insight_idx").on(t.workspaceId, t.insightId),
  }),
);
