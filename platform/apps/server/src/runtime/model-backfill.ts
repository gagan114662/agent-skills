/**
 * Per-workspace fleet-model data backfill (#293) — the pure, idempotent decision at its heart.
 *
 * Migration 0246 added the `workspace_agent_credentials.model` override column and rewrote the one
 * live-confirmed bad id (`claude-fable-5` → `claude-opus-4-8`). But that rewrite (a) only matched that
 * EXACT string and (b) "did not run against prod or did not cover existing rows" (the runner reported
 * "nothing pending" because 0246's filename was already in `_migrations`). So a workspace can still sit
 * pinned to an unservable model and every `claude -p --model <unservable>` session 403s and exits 1 →
 * the owner sees "the model THIS WORKSPACE is set to use isn't available".
 *
 * This module computes — purely, with no IO — the set of rows to repair: every NON-NULL override that
 * is NOT in the servable set ({@link isKnownModel}) is rewritten to the managed default
 * ({@link DEFAULT_AGENT_MODEL}). A `null` override is left alone (it already means "use the deployment
 * default"), and an already-servable override is left alone. That makes the plan IDEMPOTENT: feeding it
 * the rows produced by a prior apply yields zero further changes, because every row is then either null
 * or servable, and the target itself is servable.
 *
 * The premortem (#200 §3) demands production-grounded verification — so the apply path (the CLI) reads
 * the rows back from the real DB and re-plans to prove zero remain. This module is the single source of
 * truth for "what counts as a row that needs repair", shared by the SQL migration (anti-drift test),
 * the CLI dry-run preview, and the post-apply receipt check.
 */
import { DEFAULT_AGENT_MODEL, isKnownModel } from "./models.js";

/** One workspace's stored fleet-model override, exactly as it sits in `workspace_agent_credentials`. */
export interface WorkspaceModelRow {
  workspaceId: string;
  /** The owner-picked model; `null` ⇒ no override (the deployment default is used). */
  model: string | null;
}

/** A single repair the backfill would make: rewrite one workspace's unservable override to the default. */
export interface ModelBackfillChange {
  workspaceId: string;
  /** The stored unservable value, verbatim (an empty string is reported as `"(empty)"` for legibility). */
  from: string;
  /** What it will become — always the managed default, which is itself always servable. */
  to: string;
}

/** The full, reviewable plan. Pure output of {@link planModelBackfill} — no row is touched to build it. */
export interface ModelBackfillPlan {
  /** Exactly the rows that would change (the "dry-run reports the exact rows" requirement). */
  changes: ModelBackfillChange[];
  /** How many rows were inspected. */
  scanned: number;
  /** Rows left untouched: a `null` override, or one already on a servable model. */
  unchanged: number;
  /** The value every change targets — the managed, always-servable default. */
  target: string;
}

/** Render a stored value for the change report; a literal empty string is otherwise invisible. */
function displayFrom(model: string): string {
  return model.length === 0 ? "(empty)" : model;
}

/**
 * Decide which workspace model overrides to repair. Pure + total: same input → same plan, no IO, never
 * throws. A row needs repair iff its `model` is non-null AND not servable (an unknown id like
 * `claude-fable-5`, a blank string, or any value outside {@link isKnownModel}); the repair always sets
 * the managed {@link DEFAULT_AGENT_MODEL}. Idempotent — re-planning the post-apply rows yields `changes: []`.
 */
export function planModelBackfill(
  rows: readonly WorkspaceModelRow[],
  env: NodeJS.ProcessEnv = process.env,
): ModelBackfillPlan {
  const target = DEFAULT_AGENT_MODEL;
  const changes: ModelBackfillChange[] = [];
  for (const row of rows) {
    // A null override already means "use the deployment default" — nothing to repair.
    if (row.model === null) continue;
    // An already-servable override is the owner's valid pick — leave it untouched.
    if (isKnownModel(row.model, env)) continue;
    // Non-null + unservable → the crash class. Rewrite to the managed default.
    changes.push({ workspaceId: row.workspaceId, from: displayFrom(row.model), to: target });
  }
  return {
    changes,
    scanned: rows.length,
    unchanged: rows.length - changes.length,
    target,
  };
}

/**
 * Whether a set of rows is already fully repaired (no non-null unservable override remains). The
 * production-grounded receipt check: the CLI re-reads the rows AFTER applying and asserts this is true,
 * never assuming the write landed (#200 §2/§3).
 */
export function isFullyRepaired(
  rows: readonly WorkspaceModelRow[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return planModelBackfill(rows, env).changes.length === 0;
}
