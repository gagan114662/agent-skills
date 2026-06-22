/**
 * Brand + factual-accuracy gate config (issue #627). Deliberately **self-contained**: every tunable is read
 * straight from the process environment, so this feature adds NO edit to the shared `config/schema.ts` barrel
 * and stays free of parallel-merge conflicts with sibling branches (the same pattern as content-guard #674,
 * budget-governor #670 and lead-scoring #611).
 *
 * This is a SAFETY gate, so — like content-guard — it is ON by default and the ENFORCEMENT itself is not
 * switch-off-able. Only the strictness knobs are tunable, and the relaxations bottom out at "hard failures
 * still block", never at "publish anything":
 *
 *   - `BRAND_FACT_GATE_MIN_VOICE_SCORE`   integer 0–100   (default 70) — brand-voice floor.
 *   - `BRAND_FACT_GATE_MAX_UNSOURCED`     integer ≥ 0     (default 0)  — unsourced claims tolerated.
 *   - `BRAND_FACT_GATE_BLOCK_HIGH_VOICE`  on|off          (default on) — always block high-severity voice hits.
 *   - `BRAND_FACT_GATE_BLOCK_HIGH_FACT`   on|off          (default on) — always block high-severity unsourced claims.
 */

import { DEFAULT_PUBLISH_GATE_POLICY, type PublishGatePolicy } from "./gate.js";

/** Resolve the publish-gate policy from the environment. Pure given its `env` argument. */
export function resolvePublishGatePolicy(env: NodeJS.ProcessEnv = process.env): PublishGatePolicy {
  return {
    minVoiceScore: parseIntInRange(
      env.BRAND_FACT_GATE_MIN_VOICE_SCORE,
      DEFAULT_PUBLISH_GATE_POLICY.minVoiceScore,
      0,
      100,
    ),
    maxUnsourcedClaims: parseIntInRange(
      env.BRAND_FACT_GATE_MAX_UNSOURCED,
      DEFAULT_PUBLISH_GATE_POLICY.maxUnsourcedClaims,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    blockOnHighSeverityVoice: parseOnOff(
      env.BRAND_FACT_GATE_BLOCK_HIGH_VOICE,
      DEFAULT_PUBLISH_GATE_POLICY.blockOnHighSeverityVoice,
    ),
    blockOnHighSeverityFact: parseOnOff(
      env.BRAND_FACT_GATE_BLOCK_HIGH_FACT,
      DEFAULT_PUBLISH_GATE_POLICY.blockOnHighSeverityFact,
    ),
  };
}

/** Parse a bounded integer; a missing / invalid / out-of-range value falls back to `fallback`. */
function parseIntInRange(raw: string | undefined, fallback: number, lo: number, hi: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < lo || n > hi) return fallback;
  return n;
}

/** Parse an on/off flag. `off`/`false`/`0`/`no` ⇒ false; `on`/`true`/`1`/`yes` ⇒ true; anything else ⇒ `fallback`. */
function parseOnOff(raw: string | undefined, fallback: boolean): boolean {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "off":
    case "false":
    case "0":
    case "no":
      return false;
    case "on":
    case "true":
    case "1":
    case "yes":
      return true;
    default:
      return fallback;
  }
}
