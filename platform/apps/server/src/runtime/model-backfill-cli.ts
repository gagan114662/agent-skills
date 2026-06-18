/**
 * `node dist/runtime/model-backfill-cli.js` (script: `pnpm --filter @reload/server model:backfill`) —
 * the owner-gated repair for #293: rewrite every workspace `model` override that is pinned to an
 * unservable id to the managed default, so a workspace can never sit stuck on `claude-fable-5` (or any
 * other unservable id) with every session 403-ing out.
 *
 * SAFETY MODEL (the premortem, #200 §4 — this is an IRREVERSIBLE prod data write):
 *   • DRY-RUN BY DEFAULT. It prints the EXACT rows it would change and exits 0 WITHOUT writing.
 *   • It only writes when explicitly armed with `MODEL_BACKFILL_APPLY=1` — the owner-gated prod run.
 *   • After applying it READS THE ROWS BACK from the real DB and re-plans, asserting zero remain
 *     (production-grounded receipts, #200 §2/§3 — never assume the write landed). A row still unservable
 *     after apply fails the run closed (exit non-zero).
 *
 * The pure decision (which rows, what target) lives in {@link planModelBackfill}; this file owns only the
 * IO (read rows / apply one change / read back) and the exit code, and takes those as injectable deps so a
 * unit test pins dry-run-never-writes, apply-then-verify, and fail-closed behaviour with no database.
 */
import {
  planModelBackfill,
  isFullyRepaired,
  type ModelBackfillPlan,
  type WorkspaceModelRow,
} from "./model-backfill.js";

export interface ModelBackfillDeps {
  /** Read every workspace model override from the DB (the rows to inspect). */
  readRows: () => Promise<WorkspaceModelRow[]>;
  /** Persist one repair: set `workspaceId`'s override to `model`. Called ONLY in apply mode. */
  applyChange: (workspaceId: string, model: string) => Promise<void>;
  /** `false` (default) = dry-run, never writes. `true` = the armed, owner-gated prod write. */
  apply?: boolean;
  /** Models-known-to-resolve env (RELOAD_KNOWN_MODELS escape hatch). */
  env?: NodeJS.ProcessEnv;
  /** Secret-free progress sink (console.log by default). */
  log?: (line: string) => void;
}

export interface ModelBackfillReport {
  /** Whether the run was armed to write (vs. a dry-run preview). */
  applied: boolean;
  /** The plan computed from the rows read at the start. */
  plan: ModelBackfillPlan;
  /** Number of rows actually written (0 in dry-run). */
  written: number;
  /** Post-apply read-back proof that no unservable override remains (null in dry-run — nothing written). */
  verifiedClean: boolean | null;
  /** True iff the run did what it set out to: dry-run always; apply iff the read-back is clean. */
  ok: boolean;
}

/**
 * Run the backfill. Dry-run by default: compute + print the plan, write nothing. When `apply` is true,
 * write each change, then read the rows back and re-plan to PROVE zero unservable overrides remain; the
 * run is `ok` only if that read-back is clean (fail-closed). Never throws on a row — IO errors propagate
 * from the injected deps to the caller, which maps them to a non-zero exit.
 */
export async function runModelBackfill(deps: ModelBackfillDeps): Promise<ModelBackfillReport> {
  const env = deps.env ?? process.env;
  const apply = deps.apply ?? false;
  const log = deps.log ?? ((line: string) => console.log(line));

  const rows = await deps.readRows();
  const plan = planModelBackfill(rows, env);

  log(
    `[model-backfill] scanned ${plan.scanned} workspace override(s): ${plan.changes.length} need repair, ` +
      `${plan.unchanged} already valid/null. Target = ${plan.target}.`,
  );
  for (const change of plan.changes) {
    log(`[model-backfill]   ${change.workspaceId}: ${change.from} -> ${change.to}`);
  }

  if (plan.changes.length === 0) {
    log("[model-backfill] nothing to repair — every override is already servable or null.");
    return { applied: apply, plan, written: 0, verifiedClean: apply ? true : null, ok: true };
  }

  if (!apply) {
    log(
      "[model-backfill] DRY-RUN — no rows written. Re-run with MODEL_BACKFILL_APPLY=1 to apply (owner-gated, " +
        "irreversible). See ADR-0293.",
    );
    return { applied: false, plan, written: 0, verifiedClean: null, ok: true };
  }

  // Armed: the owner-gated prod write.
  let written = 0;
  for (const change of plan.changes) {
    await deps.applyChange(change.workspaceId, change.to);
    written += 1;
  }
  log(`[model-backfill] applied ${written} repair(s).`);

  // Production-grounded receipt (#200): read back from the real DB and re-plan — never assume.
  const after = await deps.readRows();
  const verifiedClean = isFullyRepaired(after, env);
  const remaining = planModelBackfill(after, env).changes;
  if (verifiedClean) {
    log(`[model-backfill] VERIFIED: ${after.length} override(s) read back, 0 unservable remain.`);
  } else {
    log(
      `[model-backfill] FAILED VERIFICATION: ${remaining.length} override(s) still unservable after apply: ` +
        remaining.map((c) => c.workspaceId).join(", "),
    );
  }
  return { applied: true, plan, written, verifiedClean, ok: verifiedClean };
}

// Run as a CLI only when invoked directly (not when imported by tests).
const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("model-backfill-cli.ts") || invokedPath.endsWith("model-backfill-cli.js")) {
  const apply = process.env.MODEL_BACKFILL_APPLY === "1";
  // Imported lazily so importing this module in a unit test never pulls in the DB layer.
  void import("../db/repositories/agent-credentials.js")
    .then(async ({ listWorkspaceModelOverrides, backfillWorkspaceModel }) => {
      if (apply) {
        console.log(
          "[model-backfill] APPLY MODE (MODEL_BACKFILL_APPLY=1) — this writes IRREVERSIBLE prod data. " +
            "It should only ever run after a reviewed dry-run, by the owner.",
        );
      } else {
        console.log("[model-backfill] dry-run (set MODEL_BACKFILL_APPLY=1 to apply).");
      }
      const report = await runModelBackfill({
        readRows: () => listWorkspaceModelOverrides(),
        applyChange: (workspaceId, model) => backfillWorkspaceModel(workspaceId, model),
        apply,
      });
      if (!report.ok) {
        console.error("[model-backfill] run did not complete cleanly — see verification output above.");
        process.exit(1);
      }
    })
    .catch((err: unknown) => {
      console.error("[model-backfill] error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
