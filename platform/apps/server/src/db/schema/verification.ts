import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  doublePrecision,
  jsonb,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Deliverable Verification Layer storage (issue #191, ADR-0191) — "nothing ships unverified". Two
 * additive, **append-only** tables; no existing table is touched (zero sibling-migration collision risk).
 *
 *   - `verification_criteria` records the DEFINITION OF DONE derived from a session's brief BEFORE it
 *     executes (#191 AC #1) — the spec the deliverable is graded against, visible per session.
 *   - `verification_verdicts` records each INDEPENDENT verifier pass (#191 AC #2-4): the per-criterion
 *     pass/fail + confidence, whether the grader was independent of the worker, whether the production
 *     tier was met, the retry count, and the #13 approval card / escalation it opened.
 *
 * `deliverable_ref`, `worker_member_id`, `grader_member_id`, and `approval_request_id` are **soft
 * references** (no FK) so a verdict outlives a pruned subject/session/request; only `workspace_id`
 * carries the #3 tenant boundary (`onDelete: cascade`). Free-form text is redacted (#25) before persist.
 */

export const DELIVERABLE_KINDS = [
  "outbound_content",
  "support_reply",
  "campaign_change",
  "venture_deploy",
] as const;
export const REVERSIBILITY_CLASSES = ["reversible", "cheap", "irreversible"] as const;
/** Mirrors the pure {@link VerificationAction} taxonomy — the terminal action persisted per verdict. */
export const VERIFICATION_VERDICT_STATUSES = [
  "auto_proceed",
  "request_approval",
  "return_to_worker",
  "escalate",
] as const;

/** One definition of done — the spec a deliverable is graded against (one row per deliverable). */
export const verificationCriteria = pgTable(
  "verification_criteria",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Soft ref to the deliverable/session this DoD belongs to (a session id / deliverable id). */
    deliverableRef: text("deliverable_ref").notNull(),
    deliverableKind: text("deliverable_kind", { enum: DELIVERABLE_KINDS }).notNull(),
    reversibility: text("reversibility", { enum: REVERSIBILITY_CLASSES }).notNull(),
    /** The success criteria array (the `SuccessCriterion[]` shape). */
    criteria: jsonb("criteria").notNull(),
    /** A short, REDACTED digest of the brief the criteria were derived from (visibility). */
    briefDigest: text("brief_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // "the latest DoD for this deliverable" — (workspace, deliverable_ref) newest-first.
    byDeliverable: index("verification_criteria_deliverable_idx").on(
      t.workspaceId,
      t.deliverableRef,
      t.createdAt,
    ),
    kindCk: check(
      "verification_criteria_kind_ck",
      sql`${t.deliverableKind} IN ('outbound_content','support_reply','campaign_change','venture_deploy')`,
    ),
    reversibilityCk: check(
      "verification_criteria_reversibility_ck",
      sql`${t.reversibility} IN ('reversible','cheap','irreversible')`,
    ),
  }),
);

/** One independent verification verdict — the durable proof attached to the approval card / escalation. */
export const verificationVerdicts = pgTable(
  "verification_verdicts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    deliverableRef: text("deliverable_ref").notNull(),
    deliverableKind: text("deliverable_kind", { enum: DELIVERABLE_KINDS }).notNull(),
    /** The terminal action the layer decided this pass. */
    status: text("status", { enum: VERIFICATION_VERDICT_STATUSES }).notNull(),
    /** Whether every REQUIRED check passed. */
    passed: boolean("passed").notNull(),
    /** Aggregate (min over required) confidence, 0..1. */
    confidence: doublePrecision("confidence").notNull(),
    reversibility: text("reversibility", { enum: REVERSIBILITY_CLASSES }).notNull(),
    /** The "worker never grades its own homework" invariant (#191 AC #2). */
    independenceOk: boolean("independence_ok").notNull(),
    /** Whether the production-grounded final tier was met where required (premortem #3). */
    productionGrounded: boolean("production_grounded").notNull(),
    /** How many fail→fix retries preceded this verdict (#191 AC #3). */
    retryCount: integer("retry_count").notNull().default(0),
    /** The per-criterion `CheckResult[]` (REDACTED evidence) — the proof shown on the card (#191 AC #4). */
    checks: jsonb("checks").notNull(),
    /** Soft ref to the worker that produced the deliverable. */
    workerMemberId: uuid("worker_member_id"),
    /** Soft ref to the independent grader. */
    graderMemberId: uuid("grader_member_id"),
    /** The #13 request opened on request_approval / escalate (soft ref), or null on auto_proceed. */
    approvalRequestId: uuid("approval_request_id"),
    /** A short, REDACTED reason for the decision. */
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // "the latest verdict for this deliverable" — (workspace, deliverable_ref) newest-first.
    byDeliverable: index("verification_verdicts_deliverable_idx").on(
      t.workspaceId,
      t.deliverableRef,
      t.createdAt,
    ),
    // The console/window read is "(workspace) newest-first".
    byCreated: index("verification_verdicts_workspace_created_idx").on(t.workspaceId, t.createdAt),
    kindCk: check(
      "verification_verdicts_kind_ck",
      sql`${t.deliverableKind} IN ('outbound_content','support_reply','campaign_change','venture_deploy')`,
    ),
    statusCk: check(
      "verification_verdicts_status_ck",
      sql`${t.status} IN ('auto_proceed','request_approval','return_to_worker','escalate')`,
    ),
    reversibilityCk: check(
      "verification_verdicts_reversibility_ck",
      sql`${t.reversibility} IN ('reversible','cheap','irreversible')`,
    ),
  }),
);
