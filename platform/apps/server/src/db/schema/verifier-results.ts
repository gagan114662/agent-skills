import { pgTable, uuid, text, doublePrecision, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Outcome Verifiers storage (issue #106, ADR-0106). One additive, **append-only** table; no existing
 * table is touched. Each row is a durable, tenant-scoped verdict on a non-code claim (deploy live?
 * revenue real? growth moved? fix held?) — the measured value, the threshold, and (on a failure) the
 * #13 escalation it opened. This is the shared evidence signal the venture scorecard (#96), the
 * flywheel (#117), and the autonomy pricer (#119) read.
 */

export const VERIFIER_RESULT_KINDS = [
  "deploy_live",
  "revenue_real",
  "growth_metric",
  "fix_held",
] as const;
export const VERIFIER_RESULT_STATUSES = ["passed", "failed", "errored"] as const;

/**
 * One verification verdict. `claim_ref` (the subject — a deployment / venture / fingerprint id) and
 * `escalation_request_id` are **soft references** (no FK) so a verdict outlives a pruned subject/request;
 * only `workspace_id` carries the #3 tenant boundary (`onDelete: cascade`). `detail` is redacted (#25)
 * before persist. Append-only — never updated.
 */
export const verifierResults = pgTable(
  "verifier_results",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: VERIFIER_RESULT_KINDS }).notNull(),
    /** Soft ref to the verified subject (deployment / venture / fingerprint id). */
    claimRef: text("claim_ref").notNull(),
    status: text("status", { enum: VERIFIER_RESULT_STATUSES }).notNull(),
    /** The measured value behind the verdict (status code / event count / delta / recurrence count). */
    measuredValue: doublePrecision("measured_value").notNull(),
    /** The threshold it was checked against. */
    threshold: doublePrecision("threshold").notNull(),
    /** A short, REDACTED human summary of the verdict. */
    detail: text("detail").notNull(),
    /** The #13 request opened on a failed verification (soft ref), or null on a pass / un-escalated. */
    escalationRequestId: uuid("escalation_request_id"),
    /** Free-form provenance tag (e.g. `deploy`, `flywheel`, `billing`). */
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The "latest verdict for this claim" read is "(workspace, kind, claim_ref) newest-first".
    byClaim: index("verifier_results_claim_idx").on(
      t.workspaceId,
      t.kind,
      t.claimRef,
      t.createdAt,
    ),
    // The console/window read is "(workspace) newest-first".
    byCreated: index("verifier_results_workspace_created_idx").on(t.workspaceId, t.createdAt),
    kindCk: check(
      "verifier_results_kind_ck",
      sql`${t.kind} IN ('deploy_live','revenue_real','growth_metric','fix_held')`,
    ),
    statusCk: check(
      "verifier_results_status_ck",
      sql`${t.status} IN ('passed','failed','errored')`,
    ),
  }),
);
