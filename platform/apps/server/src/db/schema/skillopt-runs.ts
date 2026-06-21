import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  doublePrecision,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { approvalRequests } from "./approvals.js";

/**
 * SkillOpt-Sleep run persistence (#283, ADR-0283) — the durable AUDIT LEDGER for the offline
 * self-improvement loop. The pure cycle (`src/skillopt/`) already harvests → mines → gates → stages a
 * bounded proposal in the #13 queue; these tables add the missing persistence so a nightly run is recorded,
 * the loop can MEASURE itself (the before/after validation signal), and it stays idempotent (it never
 * re-stages the same edit against the same doc while a proposal is pending).
 *
 * Premortem (#200): holds NO money, NO secret — it records that a proposal was STAGED for the owner (the
 * `requestId` links the #13 row), never that one was adopted. Adoption stays human-gated in the approval
 * queue; this ledger never grants new authority. Additive + workspace-scoped (#3, ON DELETE CASCADE).
 */
export const skilloptRuns = pgTable(
  "skillopt_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Whether the loop was enabled for this workspace (false ⇒ no agents processed). */
    enabled: boolean("enabled").notNull(),
    /** Fleet agents the cycle ran for this pass. */
    agentsProcessed: integer("agents_processed").notNull().default(0),
    /** Proposals newly parked in the #13 queue this run. */
    stagedCount: integer("staged_count").notNull().default(0),
    /** Staged decisions suppressed as already-proposed (idempotency). */
    dedupedCount: integer("deduped_count").notNull().default(0),
    /** Agents that produced no proposal (each with a reason on its outcome row). */
    skippedCount: integer("skipped_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("skillopt_runs_workspace_idx").on(t.workspaceId, t.createdAt),
  }),
);

/** Per-agent outcome status of a run. */
export const SKILLOPT_PROPOSAL_STATUSES = ["staged", "deduped", "skipped"] as const;
export type SkillOptProposalStatus = (typeof SKILLOPT_PROPOSAL_STATUSES)[number];

/**
 * One row per agent outcome of a run. For a STAGED outcome the validation columns carry the held-out,
 * externally-verified BEFORE/AFTER reading (`baseline` → `candidate`) and `improvementRatio` — the
 * measurable self-improvement signal. For a SKIPPED/DEDUPED outcome they are null and `skipReason` explains
 * why. The (`agentHandle`, `clusterKey`, `currentDocSha`) triple is the idempotency key.
 */
export const skilloptProposals = pgTable(
  "skillopt_proposals",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    runId: uuid("run_id")
      .notNull()
      .references(() => skilloptRuns.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentHandle: text("agent_handle").notNull(),
    skillId: text("skill_id").notNull(),
    status: text("status", { enum: SKILLOPT_PROPOSAL_STATUSES }).notNull(),
    /** Why no proposal was staged (skipped/deduped only). */
    skipReason: text("skip_reason"),
    /** The mined recurring-task key the edit addresses. */
    clusterKey: text("cluster_key"),
    /** The validation metric id (e.g. `email.reply_rate`). */
    metric: text("metric"),
    /** Metric orientation (false ⇒ lower-is-better). */
    higherIsBetter: boolean("higher_is_better"),
    /** BEFORE: metric under the current skill doc. */
    baseline: doublePrecision("baseline"),
    /** AFTER: metric under the proposed skill doc. */
    candidate: doublePrecision("candidate"),
    /** The measured relative improvement over baseline (the signal). */
    improvementRatio: doublePrecision("improvement_ratio"),
    /** Held-out replay size behind the reading. */
    sampleSize: integer("sample_size"),
    /** True ⇒ the reading came from external receipts (#200 §2). */
    externallyVerified: boolean("externally_verified"),
    /** The doc sha the proposal pins (reversible adoption). */
    currentDocSha: text("current_doc_sha"),
    /** The #13 request id, if a proposal was staged (null when skipped/deduped, or if the request is gone). */
    requestId: uuid("request_id").references(() => approvalRequests.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRun: index("skillopt_proposals_run_idx").on(t.runId),
    byWorkspace: index("skillopt_proposals_workspace_idx").on(t.workspaceId, t.createdAt),
    dedup: index("skillopt_proposals_dedup_idx").on(
      t.workspaceId,
      t.agentHandle,
      t.clusterKey,
      t.currentDocSha,
    ),
  }),
);
