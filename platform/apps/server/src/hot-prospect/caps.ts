/**
 * Hot-prospect alerting config (issue #622). Deliberately **self-contained** in the manner of the #670
 * budget-governor and #674 content-guard modules: every tunable is read straight from the process
 * environment, so this feature adds NO edit to the shared `config/schema.ts` barrel and stays free of
 * parallel-merge conflicts with sibling branches.
 *
 * Default **OFF and inert**. Like a money/irreversible gate (and unlike the always-on #585 memory graph),
 * hot-prospect alerting *routes outbound notifications*, so it ships disabled: until a deployment sets
 * `HOT_PROSPECT_ALERTING_ENABLED=1`, scans return no alerts, park no approvals, and send nothing. The value
 * lands the moment it is switched on — no per-deployment code wiring.
 *
 * The intent MODEL (per-kind weights + burst thresholds) is NOT env-tunable — those are governed constants in
 * {@link DEFAULT_INTENT_RULES} (a retune is a code review, not a deploy knob), exactly as the #611
 * lead-scoring weights are. What IS env-tunable is the operating envelope:
 *
 *   - `HOT_PROSPECT_ALERTING_ENABLED`  — master switch. Default OFF.
 *   - `HOT_PROSPECT_WINDOW_HOURS`      — how far back activity counts toward intent. Default 24h ("today").
 *   - `HOT_PROSPECT_SCORE_THRESHOLD`   — the weighted-score line that marks a prospect "hot". Default 20.
 *   - `HOT_PROSPECT_COOLDOWN_HOURS`    — don't re-alert the same prospect within this window (anti-spam). Default 24h.
 */

import type { ProspectSignalKind } from "./types.js";

/** One rule in the intent model: a signal kind's weight, and the burst count that fires an alert on its own. */
export interface IntentRule {
  kind: ProspectSignalKind;
  /** Human label used in the explanation + alert card. */
  label: string;
  /** Points each occurrence adds to the windowed intent score (saturating at {@link IntentRule.saturateAt}). */
  weight: number;
  /** Count at which this kind stops adding score (diminishing returns) — one metric can't run away with it. */
  saturateAt: number;
  /**
   * If this many events of this kind land inside the window, the rule fires on its own (regardless of the
   * weighted score). This is the "visited pricing 3x today" trigger #622 calls out. `0` ⇒ no burst rule.
   */
  burstThreshold: number;
}

/**
 * The governed intent model. Ordered strongest-intent-first (ordering is documentation, not logic). Weights
 * and thresholds are constants on purpose: the acceptance criterion is an explainable, reviewable alert, not a
 * per-deploy-tunable black box.
 */
export const DEFAULT_INTENT_RULES: readonly IntentRule[] = [
  { kind: "pricing_view", label: "Pricing-page views", weight: 8, saturateAt: 3, burstThreshold: 3 },
  { kind: "pricing_calculator", label: "Pricing-calculator use", weight: 10, saturateAt: 2, burstThreshold: 2 },
  { kind: "demo_session", label: "Demo sessions", weight: 9, saturateAt: 2, burstThreshold: 2 },
  { kind: "case_study_view", label: "Case-study views", weight: 5, saturateAt: 3, burstThreshold: 3 },
  { kind: "doc_view", label: "Docs views", weight: 4, saturateAt: 4, burstThreshold: 0 },
  { kind: "email_click", label: "Email clicks", weight: 4, saturateAt: 3, burstThreshold: 0 },
  { kind: "email_open", label: "Email opens", weight: 2, saturateAt: 4, burstThreshold: 0 },
  { kind: "site_visit", label: "Site visits", weight: 1, saturateAt: 6, burstThreshold: 0 },
];

/** The resolved operating envelope (master switch + windows + threshold) plus the governed model. */
export interface HotProspectPolicy {
  /** Master switch. OFF by default — the module is inert until a deployment turns it on. */
  enabled: boolean;
  /** Activity older than this (ms before "now") doesn't count toward intent. */
  windowMs: number;
  /** Weighted-score line at/above which a prospect is "hot" (a burst rule also fires independently). */
  scoreThreshold: number;
  /** Don't raise a second alert for the same prospect within this many ms of the last one. */
  cooldownMs: number;
  /** The governed intent model (never env-tunable). */
  rules: readonly IntentRule[];
}

const HOUR_MS = 60 * 60 * 1000;

export const HOT_PROSPECT_DEFAULTS = {
  enabled: false,
  windowMs: 24 * HOUR_MS,
  scoreThreshold: 20,
  cooldownMs: 24 * HOUR_MS,
} as const;

/**
 * Parse a boolean-ish env flag with a default. `1`/`true`/`yes`/`on` ⇒ true, `0`/`false`/`no`/`off` ⇒ false
 * (case-insensitive); anything else (including unset) keeps `fallback`.
 */
function envFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

/** Parse a positive-number hours env value into ms; missing/invalid/non-positive keeps `fallbackMs`. */
function envHoursMs(raw: string | undefined, fallbackMs: number): number {
  if (raw === undefined) return fallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  return Math.trunc(n * HOUR_MS);
}

/** Parse a non-negative score floor; missing/invalid/negative keeps the default. */
function envScore(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** Resolve the hot-prospect policy from the environment (defaults applied). Pure given its `env` argument. */
export function resolveHotProspectPolicy(env: NodeJS.ProcessEnv = process.env): HotProspectPolicy {
  return {
    enabled: envFlag(env.HOT_PROSPECT_ALERTING_ENABLED, HOT_PROSPECT_DEFAULTS.enabled),
    windowMs: envHoursMs(env.HOT_PROSPECT_WINDOW_HOURS, HOT_PROSPECT_DEFAULTS.windowMs),
    scoreThreshold: envScore(env.HOT_PROSPECT_SCORE_THRESHOLD, HOT_PROSPECT_DEFAULTS.scoreThreshold),
    cooldownMs: envHoursMs(env.HOT_PROSPECT_COOLDOWN_HOURS, HOT_PROSPECT_DEFAULTS.cooldownMs),
    rules: DEFAULT_INTENT_RULES,
  };
}
