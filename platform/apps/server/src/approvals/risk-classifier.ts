/**
 * Fail-safe per-action risk classifier on the approval gate (issue #561). A single classification step
 * that runs in front of every side-effectful agent action (send, publish, spend, delete, permission/
 * settings change). It classifies the action low/medium/high via a cheap model call and maps the level
 * to the existing #13 approval gate — an ADDITIVE escalation layer that can only ever ADD a human gate,
 * never remove one (it never loosens {@link evaluatePolicy}; ADR-0013 §1, ADR-0243).
 *
 * The CRITICAL invariant is fail-safe: if the classifier call fails, times out, or returns garbage we
 * cannot parse, the action is treated as HIGH and ALWAYS requires human approval — nothing destructive
 * slips through when classification errors (the Sentdex/minion model: YOLO only via an explicit flag,
 * never on a classifier miss). And money/publish/delete actions carry a deterministic floor of `medium`
 * regardless of what the model says, so a hallucinated `low` can never declassify them.
 *
 * Pure + dependency-injected (the model is a single async `RiskModel` seam) so it runs offline in the
 * unit job and the fail-safe path is deterministically testable. Every classification is emitted to an
 * optional sink ({@link ClassifyDeps.onClassified}) carrying the level + rationale so it can feed the
 * observation trace (#560).
 */
import {
  evaluatePolicy,
  isMoneyAction,
  type ActionDescriptor,
  type PolicyDecision,
  type PolicyRule,
} from "./policy.js";

/** The three risk levels, ordered least → most dangerous. */
export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);
}

/** The more dangerous of two levels (used to apply the deterministic floor over the model's verdict). */
export function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Default classifier budget — a cheap model call should be fast; past this we fail safe to HIGH. */
export const DEFAULT_RISK_TIMEOUT_MS = 4000;

/** A `.publish` / known publishing action — taking content live on an outward surface. */
function isPublishAction(actionType: string): boolean {
  return /(^|[._])publish/.test(actionType);
}

/** A destructive delete/remove/destroy/purge/drop action. */
function isDeleteAction(actionType: string): boolean {
  return /(^|[._])(delete|destroy|remove|purge|drop)/.test(actionType);
}

/** A permission / settings / access-granting change (the issue's "permission/settings change" class). */
function isPermissionChangeAction(actionType: string): boolean {
  return /(^|[._])(permission|settings|grant|role|enable_agent|payout_settings|connect_account|capability)/.test(
    actionType,
  );
}

/**
 * The deterministic minimum risk for an action type, independent of the model. Money, publish, and
 * delete (plus permission/settings change) actions are ALWAYS at least `medium` — the issue's hard
 * constraint — so the classifier can never declassify a destructive action below the gate's reach even
 * if the model returns `low`. Everything else floors to `low` and is left to the model to rate.
 */
export function riskFloor(actionType: string): RiskLevel {
  if (
    isMoneyAction(actionType) ||
    isPublishAction(actionType) ||
    isDeleteAction(actionType) ||
    isPermissionChangeAction(actionType)
  ) {
    return "medium";
  }
  return "low";
}

/**
 * Parse a cheap model's raw output into a {@link RiskLevel}, or `null` when it is unusable. Accepts a
 * bare token (`"high"`), a JSON object (`{"level":"medium","rationale":"…"}`), or prose that names
 * exactly one level (`"Risk: high"`). Anything ambiguous (no level, or two conflicting levels) or
 * non-string is `null` — the caller treats `null` as a classifier MISS and fails safe to HIGH. Strict
 * on purpose: never guess a level out of garbage.
 */
export function parseRiskLevel(raw: unknown): RiskLevel | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Exact token.
  const lowerWhole = trimmed.toLowerCase();
  if (isRiskLevel(lowerWhole)) return lowerWhole;

  // JSON envelope with a `level` field.
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && "level" in parsed) {
      const lvl = (parsed as { level: unknown }).level;
      if (typeof lvl === "string" && isRiskLevel(lvl.trim().toLowerCase())) {
        return lvl.trim().toLowerCase() as RiskLevel;
      }
    }
  } catch {
    // not JSON — fall through to prose scan
  }

  // Prose naming exactly one distinct level.
  const found = new Set<RiskLevel>();
  for (const m of lowerWhole.matchAll(/\b(low|medium|high)\b/g)) {
    found.add(m[1] as RiskLevel);
  }
  if (found.size === 1) return [...found][0] ?? null;

  return null;
}

/** Optional rationale extracted from a JSON envelope, else a default describing the model's verdict. */
function rationaleFrom(raw: string, level: RiskLevel): string {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && "rationale" in parsed) {
      const r = (parsed as { rationale: unknown }).rationale;
      if (typeof r === "string" && r.trim()) return r.trim();
    }
  } catch {
    // not JSON
  }
  return `classifier rated ${level}`;
}

/** The action passed to the model classifier. Kept small so a cheap model has just enough context. */
export interface RiskModelInput {
  actionType: string;
  amount?: number | null;
  summary?: string;
  payload?: unknown;
}

/** The single injected seam: a cheap model call that returns its raw text verdict. */
export type RiskModel = (input: RiskModelInput) => Promise<string>;

/** Provenance of a {@link RiskClassification}, for the observation trace and debugging. */
export type RiskSource = "model" | "floor" | "fail-safe" | "no-model";

export interface RiskClassification {
  /** The effective level the gate uses — the max of the floor and the model's verdict. */
  level: RiskLevel;
  rationale: string;
  source: RiskSource;
  /** True iff we fell back to HIGH because the classifier failed/timed-out/returned garbage. */
  failSafe: boolean;
  /** The deterministic minimum for this action type. */
  floor: RiskLevel;
  /** What the model returned (null when no model, or on failure/garbage). */
  modelLevel: RiskLevel | null;
}

export interface ClassifyDeps {
  /** The cheap model. When omitted/null the classifier is deterministic floor-only (no escalation). */
  model?: RiskModel | null;
  /** Classifier budget; past this we fail safe to HIGH. Default {@link DEFAULT_RISK_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** #560 observation-trace sink: receives every classification (level + rationale). Best-effort. */
  onClassified?: (record: RiskClassification & { actionType: string }) => void;
}

/** A classifier timeout — surfaced distinctly so the rationale can say so, but treated as a MISS → HIGH. */
export class RiskTimeoutError extends Error {
  constructor(ms: number) {
    super(`risk classifier timed out after ${ms}ms`);
    this.name = "RiskTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RiskTimeoutError(ms)), ms);
    // Don't keep the event loop alive solely for this watchdog.
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** The fail-safe result: HIGH (always >= any floor), flagged, with the reason the classifier missed. */
function failSafe(floor: RiskLevel, why: string): RiskClassification {
  return { level: "high", rationale: `fail-safe HIGH: ${why}`, source: "fail-safe", failSafe: true, floor, modelLevel: null };
}

/**
 * Classify an action's risk. Runs the cheap model (with a timeout), parses the verdict, and applies the
 * deterministic floor. The CRITICAL guarantee: any classifier failure/timeout/garbage → HIGH. With no
 * model wired, returns the floor only (no escalation, never a fail-safe — the absence of a model is a
 * config choice, not a failure). Always emits to {@link ClassifyDeps.onClassified}.
 */
export async function classifyRisk(
  action: RiskModelInput,
  deps: ClassifyDeps = {},
): Promise<RiskClassification> {
  const floor = riskFloor(action.actionType);
  let result: RiskClassification;

  if (!deps.model) {
    result = {
      level: floor,
      rationale: "no risk model configured — deterministic floor only",
      source: "no-model",
      failSafe: false,
      floor,
      modelLevel: null,
    };
  } else {
    try {
      const raw = await withTimeout(deps.model(action), deps.timeoutMs ?? DEFAULT_RISK_TIMEOUT_MS);
      const parsed = parseRiskLevel(raw);
      if (parsed === null) {
        result = failSafe(floor, "classifier returned unparseable output");
      } else {
        const level = maxLevel(floor, parsed);
        // `floor` won when it is strictly higher than the model's (the model tried to declassify).
        const source: RiskSource = level !== parsed ? "floor" : "model";
        result = { level, rationale: rationaleFrom(raw, parsed), source, failSafe: false, floor, modelLevel: parsed };
      }
    } catch (err) {
      const why = err instanceof RiskTimeoutError ? "classifier timed out" : "classifier call failed";
      result = failSafe(floor, why);
    }
  }

  deps.onClassified?.({ actionType: action.actionType, ...result });
  return result;
}

/** A policy decision augmented with the risk classification that produced (or didn't change) it. */
export interface RiskGateDecision extends PolicyDecision {
  risk: RiskClassification;
}

/**
 * Combine the existing #13 policy decision with a risk classification — strictly ADDITIVE so it can
 * never loosen the gate:
 *   - if the base already gates → keep it verbatim (reason unchanged), just attach the risk;
 *   - else if risk is `low` → the autonomous base stands;
 *   - else (`medium`/`high`) → ESCALATE to a human gate with a risk reason.
 * `requiresApproval` is therefore `base.requiresApproval || risk.level !== "low"` — the risk layer only
 * ever turns an autonomous action into a gated one.
 */
export function gateWithRisk(base: PolicyDecision, risk: RiskClassification): RiskGateDecision {
  if (base.requiresApproval) return { ...base, risk };
  if (risk.level === "low") return { ...base, risk };
  return {
    requiresApproval: true,
    reason: `risk ${risk.level}: ${risk.rationale} — human approval required`,
    risk,
  };
}

/**
 * Convenience: evaluate the base policy, classify risk, and combine. The single call sites put in front
 * of a side-effectful action. Never loosens {@link evaluatePolicy}; on a classifier miss the action
 * requires approval (fail-safe).
 */
export async function classifyAndGate(
  action: ActionDescriptor & { summary?: string; payload?: unknown },
  rules: PolicyRule[],
  deps: ClassifyDeps = {},
): Promise<RiskGateDecision> {
  const base = evaluatePolicy(action, rules);
  const risk = await classifyRisk(
    { actionType: action.actionType, amount: action.amount, summary: action.summary, payload: action.payload },
    deps,
  );
  return gateWithRisk(base, risk);
}
