/**
 * Offline eval suite types (#155, ADR-0155 §4). The eval rails turn "skills work" from a hope into a
 * tested property. A suite is a few dozen questions per agent domain, each with a grader and an expected
 * answer; running it produces a deterministic pass-rate that CI gates and that feeds the #117 flywheel on
 * regression. **Model-free by construction** — the answerer is the real semantic layer (for metric
 * questions) or a pure skill-invariant check (for discipline questions), so the suite runs in CI with no
 * spend and no flake.
 *
 * `grade.ts` / `regression.ts` are pure; `service.ts` does the persist + trace + flywheel-feed.
 */

/** The grader kinds. Each is a pure predicate over the agent's actual answer string vs the case `expected`. */
export const GRADER_KINDS = ["exact", "contains", "numeric", "regex", "provenance"] as const;
export type GraderKind = (typeof GRADER_KINDS)[number];

export function isGraderKind(value: unknown): value is GraderKind {
  return typeof value === "string" && (GRADER_KINDS as readonly string[]).includes(value);
}

/**
 * One eval question. `kind` selects how the answer is produced (a `metric` case routes through the
 * semantic layer; a `skill` case checks a skill-file invariant); `grader` selects how it is judged.
 */
export interface EvalCase {
  id: string;
  /** The question text (also the trace input). */
  prompt: string;
  /** How the answer is produced: a governed metric lookup, or a skill-discipline invariant check. */
  kind: "metric" | "skill";
  /** For a `metric` case: the catalog metric id to resolve. */
  metricId?: string;
  /** For a `skill` case: the invariant to assert (see corpus.ts SKILL_INVARIANTS). */
  invariant?: string;
  /** The grader applied to the produced answer. */
  grader: GraderKind;
  /** The expected answer / substring / number / pattern the grader checks against. */
  expected: string;
  /** Numeric tolerance for the `numeric` grader (absolute). Default 0. */
  tolerance?: number;
}

/** A named suite of cases for one agent domain. */
export interface EvalSuite {
  /** The owning agent domain (handle), e.g. `lens`. */
  agent: string;
  /** The suite version (bumped when cases change) — logged with every run for drift tracking. */
  version: string;
  cases: EvalCase[];
}

/** The result of grading one case. */
export interface EvalCaseResult {
  caseId: string;
  passed: boolean;
  /** The actual answer the agent produced (already redacted/safe — these are deterministic strings). */
  actual: string;
  /** A short human reason on failure (empty on pass). */
  detail: string;
}

/** The roll-up of a suite run — the number CI gates and the flywheel reads. */
export interface EvalRunSummary {
  agent: string;
  version: string;
  total: number;
  passed: number;
  failed: number;
  /** passed ÷ total, 0 when empty. */
  passRate: number;
  results: EvalCaseResult[];
}

/** A persisted run row (`eval_runs`) — the maintenance audit trail the playbook calls for. */
export interface EvalRunRecord {
  id: string;
  workspaceId: string;
  agent: string;
  suiteVersion: string;
  gitSha: string;
  modelId: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  tokens: number;
  createdAt: Date;
}
