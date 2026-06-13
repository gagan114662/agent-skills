import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";

/**
 * Legal & Compliance pack persistence (#196, ADR-0196). Six additive, workspace-scoped tables that make
 * compliance a generated, versioned, audited artifact. All `workspace_id`-scoped with `onDelete: cascade`
 * (the #3 tenant boundary). `idea_id` is a **soft reference** to `venture_ideas(id)` — no FK constraint
 * (matching the #189/#197 pattern): compliance/audit records should OUTLIVE a pruned venture, and it keeps
 * the #155 metric-surface colocation latch from false-matching a plain `venture_ideas` FK reference. The
 * TS property stays `ventureIdeaId` (the public field name); only the column is `idea_id`. Tenant isolation
 * is enforced by the workspace_id FK + the app-level idea lookup. No secret lands here; migration `0196`.
 */

export const LEGAL_DOCUMENT_KINDS = ["tos", "privacy"] as const;
export const LEGAL_DOCUMENT_STATUSES = ["draft", "published"] as const;
export const SUPPRESSION_SOURCES = ["unsubscribe", "bounce", "deletion_request", "manual"] as const;
export const CONSENT_BASES = ["opt_in", "contract", "legitimate_interest"] as const;
export const COMPLIANCE_DECISIONS = ["allow", "block"] as const;
export const DATA_RIGHTS_TYPES = ["export", "deletion"] as const;
export const DATA_RIGHTS_STATUSES = ["received", "completed"] as const;

/** Per-venture legal facts the ToS/privacy generator renders from. One row per venture idea. */
export const ventureLegalFacts = pgTable(
  "legal_facts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureIdeaId: uuid("idea_id").notNull(), // soft ref to venture_ideas(id) (no FK; app-scoped)
    jurisdiction: text("jurisdiction").notNull(),
    /** Normalized lowercase data tokens (email|name|payment|analytics|ip|…). */
    dataCollected: jsonb("data_collected").notNull().default([]),
    /** Normalized payment-flow tokens (stripe_subscription|one_time|none|…). */
    paymentFlows: jsonb("payment_flows").notNull().default([]),
    industry: text("industry"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("legal_facts_workspace_idx").on(t.workspaceId),
    oneePerVenture: unique("legal_facts_idea_uq").on(t.workspaceId, t.ventureIdeaId),
  }),
);

/** Generated, versioned ToS/privacy documents. `version` is the short content hash; `source_facts_hash`
 * fingerprints the facts so a material change is detectable. One row per (venture, kind, version). */
export const legalDocuments = pgTable(
  "legal_documents",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureIdeaId: uuid("idea_id").notNull(), // soft ref to venture_ideas(id) (no FK; app-scoped)
    kind: text("kind", { enum: LEGAL_DOCUMENT_KINDS }).notNull(),
    version: text("version").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceFactsHash: text("source_facts_hash").notNull(),
    body: text("body").notNull(),
    status: text("status", { enum: LEGAL_DOCUMENT_STATUSES }).notNull().default("draft"),
    approvalRequestId: uuid("approval_request_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("legal_documents_workspace_idx").on(t.workspaceId),
    byVentureKind: index("legal_documents_idea_kind_idx").on(t.workspaceId, t.ventureIdeaId, t.kind),
    dedupe: unique("legal_documents_version_uq").on(t.workspaceId, t.ventureIdeaId, t.kind, t.version),
  }),
);

/** The suppression list — contacts that must never receive a commercial send (CAN-SPAM/CASL/GDPR opt-out,
 * bounce, or a data-deletion request). Deduped per workspace by contact. */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contact: text("contact").notNull(),
    reason: text("reason"),
    source: text("source", { enum: SUPPRESSION_SOURCES }).notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("email_suppressions_workspace_idx").on(t.workspaceId),
    dedupe: unique("email_suppressions_contact_uq").on(t.workspaceId, t.contact),
  }),
);

/** Recorded consent (the lawful basis to email a contact). Deduped per (workspace, contact, basis). */
export const consentRecords = pgTable(
  "consent_records",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contact: text("contact").notNull(),
    basis: text("basis", { enum: CONSENT_BASES }).notNull(),
    ventureIdeaId: uuid("idea_id"), // soft ref to venture_ideas(id) (no FK; app-scoped)
    sourceRef: text("source_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("consent_records_workspace_idx").on(t.workspaceId),
    byContact: index("consent_records_contact_idx").on(t.workspaceId, t.contact),
    dedupe: unique("consent_records_basis_uq").on(t.workspaceId, t.contact, t.basis),
  }),
);

/** Append-only audit of every send-layer compliance decision (allow/block + the rule + reason). */
export const complianceEvents = pgTable(
  "compliance_events",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    target: text("target"),
    decision: text("decision", { enum: COMPLIANCE_DECISIONS }).notNull(),
    reason: text("reason"),
    rules: jsonb("rules").notNull().default([]),
    actorMemberId: uuid("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("compliance_events_workspace_idx").on(t.workspaceId),
    byDecision: index("compliance_events_decision_idx").on(t.workspaceId, t.decision),
  }),
);

/** Per-venture data-subject export/deletion requests, honored end-to-end and audited (criterion 4). */
export const dataRightsRequests = pgTable(
  "data_rights_requests",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureIdeaId: uuid("idea_id"), // soft ref to venture_ideas(id) (no FK; app-scoped)
    subjectContact: text("subject_contact").notNull(),
    type: text("type", { enum: DATA_RIGHTS_TYPES }).notNull(),
    status: text("status", { enum: DATA_RIGHTS_STATUSES }).notNull().default("received"),
    requestedByMemberId: uuid("requested_by_member_id").references(() => members.id, { onDelete: "set null" }),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    byWorkspace: index("data_rights_requests_workspace_idx").on(t.workspaceId),
    byStatus: index("data_rights_requests_status_idx").on(t.workspaceId, t.status),
  }),
);
