import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { members } from "./identities.js";
import { workspaces } from "./workspaces.js";
import {
  INTENT_CATEGORIES,
  INTENT_LEAD_STATUSES,
  INTENT_SOURCES,
  type IntentEvidence,
} from "../../intent-scanner/types.js";

/**
 * #1548 always-on buying-intent scanner. Monitors define where/what to watch; leads are deduped external
 * Reddit/X threads with quoted evidence and a reply draft parked behind the owner approval queue. No table
 * here can send or post externally; approval_request_id is a soft audit link only.
 */
export const intentMonitors = pgTable(
  "intent_monitors",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    source: text("source", { enum: INTENT_SOURCES }).notNull(),
    label: text("label").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    subreddits: jsonb("subreddits").$type<string[]>().notNull().default([]),
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    competitors: jsonb("competitors").$type<string[]>().notNull().default([]),
    questionPatterns: jsonb("question_patterns").$type<string[]>().notNull().default([]),
    cadenceMinutes: integer("cadence_minutes").notNull().default(15),
    minScore: integer("min_score").notNull().default(45),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }),
    nextScanAt: timestamp("next_scan_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index("intent_monitors_due_idx").on(t.enabled, t.nextScanAt),
    workspaceIdx: index("intent_monitors_workspace_idx").on(t.workspaceId, t.createdAt),
    sourceCk: check("intent_monitors_source_ck", sql`${t.source} IN ('reddit','x')`),
    cadenceCk: check("intent_monitors_cadence_ck", sql`${t.cadenceMinutes} BETWEEN 10 AND 60`),
    minScoreCk: check("intent_monitors_min_score_ck", sql`${t.minScore} BETWEEN 0 AND 100`),
  }),
);

export const intentLeads = pgTable(
  "intent_leads",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => intentMonitors.id, { onDelete: "cascade" }),
    source: text("source", { enum: INTENT_SOURCES }).notNull(),
    externalRef: text("external_ref").notNull(),
    url: text("url").notNull(),
    authorLabel: text("author_label"),
    community: text("community"),
    title: text("title").notNull(),
    bodyExcerpt: text("body_excerpt").notNull().default(""),
    matchedQuery: text("matched_query"),
    intentCategory: text("intent_category", { enum: INTENT_CATEGORIES }).notNull(),
    intentScore: integer("intent_score").notNull(),
    evidence: jsonb("evidence").$type<IntentEvidence[]>().notNull().default([]),
    matchedSignals: jsonb("matched_signals").$type<string[]>().notNull().default([]),
    draftReply: text("draft_reply").notNull(),
    status: text("status", { enum: INTENT_LEAD_STATUSES }).notNull().default("new"),
    approvalRequestId: uuid("approval_request_id"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueExternal: uniqueIndex("intent_leads_external_uk").on(t.workspaceId, t.source, t.externalRef),
    workspaceScoreIdx: index("intent_leads_workspace_score_idx").on(t.workspaceId, t.intentScore),
    workspaceStatusIdx: index("intent_leads_workspace_status_idx").on(t.workspaceId, t.status, t.updatedAt),
    sourceCk: check("intent_leads_source_ck", sql`${t.source} IN ('reddit','x')`),
    categoryCk: check(
      "intent_leads_category_ck",
      sql`${t.intentCategory} IN ('active_purchase_research','pain_expression','competitor_churn','noise')`,
    ),
    statusCk: check(
      "intent_leads_status_ck",
      sql`${t.status} IN ('new','reply_pending_approval','approved','replied','dismissed')`,
    ),
    scoreCk: check("intent_leads_score_ck", sql`${t.intentScore} BETWEEN 0 AND 100`),
  }),
);
