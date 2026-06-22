/**
 * Configuration for the conflict-resolution arbiter (issue #587). Deliberately **self-contained**: every tunable
 * is read straight from the process environment, so this feature adds NO edit to the shared `config/schema.ts`
 * barrel and stays free of parallel-merge conflicts with sibling branches (the proven #670/#674 pattern).
 *
 * The defaults encode the issue's intent: campaign-brief alignment is the primary signal (the brief is the
 * source of truth every agent reads), expected impact second, role precedence a light tiebreak. The environment
 * can re-weight these or set the decisiveness margin and escalation TTL, but it can never disable arbitration —
 * there is no master off-switch, because "competing proposals never both ship" is a guarantee, not a feature.
 */

/** How long an escalated conflict decision stays open before it lazily expires: 7 days. */
export const DEFAULT_DECISION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Default factor weights (normalized so they sum to 1) and the default decisiveness margin. */
export const DEFAULT_WEIGHT_BRIEF = 0.5;
export const DEFAULT_WEIGHT_IMPACT = 0.35;
export const DEFAULT_WEIGHT_ROLE = 0.15;
/** Minimum score gap between the top two distinct strategies to auto-pick rather than escalate. */
export const DEFAULT_DECISIVE_MARGIN = 0.15;

export interface ConflictResolutionCaps {
  /** Weight on campaign-brief alignment (0..1). */
  weightBrief: number;
  /** Weight on expected impact (0..1). */
  weightImpact: number;
  /** Weight on role precedence (0..1). */
  weightRole: number;
  /** Score gap required between the best and second-best strategy to auto-pick; below it ⇒ escalate. */
  decisiveMargin: number;
  /**
   * Role precedence, highest authority first (e.g. ["strategist", "writer", "scout"]). A role's precedence
   * contribution is `(len - index) / len`; a role not listed contributes 0. Used as both a light score factor
   * and the final deterministic tiebreak.
   */
  rolePrecedence: string[];
  /** How long an escalated decision stays open before it lazily expires (ms). */
  decisionTtlMs: number;
}

export const CONFLICT_RESOLUTION_DEFAULTS: ConflictResolutionCaps = {
  weightBrief: DEFAULT_WEIGHT_BRIEF,
  weightImpact: DEFAULT_WEIGHT_IMPACT,
  weightRole: DEFAULT_WEIGHT_ROLE,
  decisiveMargin: DEFAULT_DECISIVE_MARGIN,
  rolePrecedence: [],
  decisionTtlMs: DEFAULT_DECISION_TTL_MS,
};

/** Parse a comma/space separated role list; lowercased, de-duped, trimmed. Empty/missing ⇒ no precedence. */
function parseRoleList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((v) => v.trim().toLowerCase())
        .filter((v) => v.length > 0),
    ),
  ];
}

/** Parse a finite, non-negative number; missing/invalid ⇒ the provided default. */
function parseNum(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** Parse a positive-integer TTL (ms); missing/invalid/non-positive ⇒ the 7-day default. */
function parseTtlMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_DECISION_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DECISION_TTL_MS;
  return Math.trunc(n);
}

/**
 * Resolve the caps from the environment (defaults applied). Pure given its `env` argument. The three factor
 * weights are normalized to sum to 1 so the composite score and margin always live on a comparable 0..1 scale;
 * if all three are zero (a misconfiguration) the safe defaults are restored.
 */
export function resolveConflictResolutionCaps(
  env: NodeJS.ProcessEnv = process.env,
): ConflictResolutionCaps {
  let wBrief = parseNum(env.CONFLICT_RES_WEIGHT_BRIEF, DEFAULT_WEIGHT_BRIEF);
  let wImpact = parseNum(env.CONFLICT_RES_WEIGHT_IMPACT, DEFAULT_WEIGHT_IMPACT);
  let wRole = parseNum(env.CONFLICT_RES_WEIGHT_ROLE, DEFAULT_WEIGHT_ROLE);
  const sum = wBrief + wImpact + wRole;
  if (sum <= 0) {
    wBrief = DEFAULT_WEIGHT_BRIEF;
    wImpact = DEFAULT_WEIGHT_IMPACT;
    wRole = DEFAULT_WEIGHT_ROLE;
  } else {
    wBrief /= sum;
    wImpact /= sum;
    wRole /= sum;
  }
  return {
    weightBrief: wBrief,
    weightImpact: wImpact,
    weightRole: wRole,
    decisiveMargin: parseNum(env.CONFLICT_RES_DECISIVE_MARGIN, DEFAULT_DECISIVE_MARGIN),
    rolePrecedence: parseRoleList(env.CONFLICT_RES_ROLE_PRECEDENCE),
    decisionTtlMs: parseTtlMs(env.CONFLICT_RES_DECISION_TTL_MS),
  };
}
