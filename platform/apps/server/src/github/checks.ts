import type { ChecksStatus, CheckRunDto } from "@reload/shared";

/**
 * Roll a PR's individual check runs up to a single status for the row + web Checks tab (#51). Pure:
 *  - `failure` if any run failed (or was cancelled/timed out) — the most actionable signal,
 *  - else `pending` while any run is still queued/in-progress,
 *  - else `success` when every run completed without failing,
 *  - `unknown` when there are no runs at all.
 */
export function rollupChecks(runs: CheckRunDto[]): ChecksStatus {
  if (runs.length === 0) return "unknown";
  if (runs.some((r) => r.conclusion === "failure" || r.conclusion === "cancelled")) return "failure";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  return "success";
}
