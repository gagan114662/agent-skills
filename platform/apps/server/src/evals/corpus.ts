/**
 * The deterministic, offline answerer (#155, ADR-0155 §4). This is what makes the eval suite run in CI
 * with no model spend and no flake: a `metric` case is answered by routing through the REAL semantic layer
 * (`catalog` + `buildAnswer`), proving the structural-routing thesis end to end; a `skill` case is answered
 * by checking a skill-file invariant (pure string predicate over the agent's loaded skill content). Both
 * are pure given the {@link AnswerContext} the service supplies (governed values + skill text).
 */

import { getMetric } from "../semantic/catalog.js";
import { buildAnswer, type ResolvedMetric } from "../semantic/answer.js";
import { gradeCase } from "./grade.js";
import {
  isGraderKind,
  type EvalCase,
  type EvalCaseResult,
  type EvalSuite,
} from "./types.js";

/**
 * Skill-file invariants the runbook/knowledge content must satisfy — the playbook's disciplines encoded as
 * grep-able predicates. A skill that drops one of these fails its own eval, which is exactly the
 * maintenance-as-code latch we want.
 */
export const SKILL_INVARIANTS: Record<string, (text: string) => boolean> = {
  /** Consults governed sources before raw data (the structural-routing rule). */
  consults_governed_first: (t) => t.includes("governed") && t.includes("before raw"),
  /** Names the semantic layer as the canonical metric path. */
  uses_semantic_layer: (t) => t.includes("semantic layer"),
  /** Flags a raw/fallback answer rather than passing it off as canonical. */
  flags_fallback: (t) => t.includes("fallback") && t.includes("flag"),
  /** Cites provenance + freshness in answers. */
  cites_provenance: (t) => t.includes("provenance") && t.includes("freshness"),
  /** Never sends/posts/spends autonomously — drafts wait for the #13 human gate. */
  no_autonomous_send: (t) => t.includes("approval") && (t.includes("never") || t.includes("draft")),
  /** Carries the house voice sign-off. */
  house_voice: (t) => t.includes("made by robots, steered by humans"),
};

/** Everything the answerer needs, supplied by the IO service (real) or a test fixture (deterministic). */
export interface AnswerContext {
  nowMs: number;
  maxAgeMs: number;
  /** Resolve a metric's governed value (the real semantic-layer resolver in prod; a fixture in CI). */
  resolve: (metricId: string) => ResolvedMetric;
  /** The concatenated skill content (knowledge + runbook) for an agent, for invariant checks. */
  skillText: (agent: string) => string;
}

/** Produce the deterministic answer string for one case. */
export function answerCase(agent: string, c: EvalCase, ctx: AnswerContext): string {
  if (c.kind === "metric") {
    const def = c.metricId ? getMetric(c.metricId) : undefined;
    if (!def) return `unknown metric: ${String(c.metricId)}`;
    return buildAnswer(def, ctx.resolve(def.id), ctx.nowMs, ctx.maxAgeMs).spoken;
  }
  // skill-discipline case
  const inv = c.invariant ? SKILL_INVARIANTS[c.invariant] : undefined;
  if (!inv) return `unknown invariant: ${String(c.invariant)}`;
  const ok = inv(ctx.skillText(agent).toLowerCase());
  // Use non-overlapping tokens — "missing" does NOT contain "satisfied", so a `contains "satisfied"`
  // grader can't be fooled by a "not satisfied" answer (the failing case must read clearly different).
  return `invariant ${c.invariant}: ${ok ? "satisfied" : "missing"}`;
}

/** Run a whole suite through the answerer + graders. Pure given `ctx`. */
export function runSuiteCases(suite: EvalSuite, ctx: AnswerContext): EvalCaseResult[] {
  return suite.cases.map((c) => gradeCase(c, answerCase(suite.agent, c, ctx)));
}

/** Validate + normalize an untrusted suite JSON blob into an {@link EvalSuite}. Throws on a bad shape. */
export function parseSuite(raw: unknown): EvalSuite {
  if (typeof raw !== "object" || raw === null) throw new Error("suite must be an object");
  const o = raw as Record<string, unknown>;
  if (typeof o.agent !== "string" || !o.agent) throw new Error("suite.agent is required");
  if (typeof o.version !== "string" || !o.version) throw new Error("suite.version is required");
  if (!Array.isArray(o.cases)) throw new Error("suite.cases must be an array");
  const cases = o.cases.map((c, i) => parseCase(c, i));
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error("suite case ids must be unique");
  return { agent: o.agent, version: o.version, cases };
}

function parseCase(raw: unknown, index: number): EvalCase {
  if (typeof raw !== "object" || raw === null) throw new Error(`case[${index}] must be an object`);
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) throw new Error(`case[${index}].id is required`);
  if (o.kind !== "metric" && o.kind !== "skill") throw new Error(`case ${o.id}: kind must be metric|skill`);
  if (!isGraderKind(o.grader)) throw new Error(`case ${o.id}: invalid grader ${String(o.grader)}`);
  if (typeof o.expected !== "string") throw new Error(`case ${o.id}: expected is required`);
  if (typeof o.prompt !== "string" || !o.prompt) throw new Error(`case ${o.id}: prompt is required`);
  return {
    id: o.id,
    prompt: o.prompt,
    kind: o.kind,
    grader: o.grader,
    expected: o.expected,
    metricId: typeof o.metricId === "string" ? o.metricId : undefined,
    invariant: typeof o.invariant === "string" ? o.invariant : undefined,
    tolerance: typeof o.tolerance === "number" ? o.tolerance : undefined,
  };
}
