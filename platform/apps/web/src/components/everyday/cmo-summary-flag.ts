/**
 * CMO summary strip flag (#1456) — a PURE gate for the new <10-second CMO top-summary strip.
 *
 * Unlike the everyday-shell flag (#784, default-ON), this NEW surface ships DEFAULT-OFF and owner-workspace-first,
 * per the task's rollout rule for any new capability: prove it on the owner workspace before any wider rollout.
 * The strip itself is read-only (no sends, no spend, no irreversible action), but we still stage it conservatively.
 *
 *   · DEFAULT-OFF      — env unset ⇒ flag off. Only "true"/"1" turns it on.
 *   · OWNER-FIRST      — when an owner workspace id is configured, the strip shows ONLY for that workspace.
 *                        With no owner id configured, an on flag shows it for any signed-in workspace.
 *   · FAIL-CLOSED      — off flag, missing workspace, or owner-mismatch ⇒ hidden.
 */

const env = import.meta.env;

/** Read a string env value, coercing away non-strings/empties. */
function readEnv(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Master switch — `VITE_CMO_SUMMARY_STRIP`. Default OFF; only "true"/"1" turns it on. */
export const CMO_SUMMARY_ENABLED: boolean = (() => {
  const raw = readEnv(env.VITE_CMO_SUMMARY_STRIP);
  return raw === "true" || raw === "1";
})();

/** Owner-workspace narrowing — `VITE_CMO_SUMMARY_OWNER_WORKSPACE_ID`. When set, the strip is owner-only. */
export const CMO_SUMMARY_OWNER_WORKSPACE_ID: string | undefined = readEnv(
  env.VITE_CMO_SUMMARY_OWNER_WORKSPACE_ID,
);

export interface CmoSummaryGateInput {
  /** The master flag (default OFF). */
  readonly flagOn: boolean;
  /** Configured owner workspace id; when present the strip shows only for that workspace. */
  readonly ownerWorkspaceId?: string | null | undefined;
  /** The current workspace id. */
  readonly workspaceId?: string | null | undefined;
}

/**
 * Decide whether the CMO summary strip shows. PURE so every branch is unit-tested without a DOM.
 *
 *   off flag ⇒ no · no current workspace ⇒ no · owner id set and mismatched ⇒ no · otherwise ⇒ yes.
 */
export function shouldShowCmoSummary(input: CmoSummaryGateInput): boolean {
  if (!input.flagOn) return false;
  const ws = input.workspaceId?.trim();
  if (!ws) return false;
  const owner = input.ownerWorkspaceId?.trim();
  if (owner && owner !== ws) return false;
  return true;
}
