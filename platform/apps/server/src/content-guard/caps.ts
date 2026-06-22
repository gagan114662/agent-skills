/**
 * Content-guard config (issue #674). Deliberately **self-contained**: the one tunable — the severity at which
 * external content is hard-blocked — is read directly from the process environment, so this feature adds NO
 * edit to the shared `config/schema.ts` barrel and stays free of parallel-merge conflicts with sibling
 * branches.
 *
 * Note the inversion from the usual "default-OFF, owner-workspace-first" feature switch: this is a SAFETY
 * guardrail, so it is ON by default and cannot be switched off. The human-approval requirement for
 * external-derived actions is NOT configurable at all — only the *additional* hard-block threshold is, and it
 * can only be relaxed as far as "approval still required" (`CONTENT_GUARD_HARD_BLOCK=off`), never to autopilot.
 */

import type { GatePolicy } from "./gate.js";

/** Resolve the gate policy from the environment. Pure given its `env` argument. */
export function resolveGatePolicy(env: NodeJS.ProcessEnv = process.env): GatePolicy {
  return { hardBlockAtSeverity: parseHardBlock(env.CONTENT_GUARD_HARD_BLOCK) };
}

/**
 * Parse `CONTENT_GUARD_HARD_BLOCK`: `low` | `medium` | `high` set the hard-block threshold; `off` disables
 * hard-blocking (external content still requires approval). A missing/invalid value defaults to `high` — the
 * safest sensible default (block only on high-confidence injection, gate everything else).
 */
function parseHardBlock(raw: string | undefined): GatePolicy["hardBlockAtSeverity"] {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "off":
    case "none":
      return "off";
    default:
      return "high";
  }
}
