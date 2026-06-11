/**
 * Eval-gated maintenance service (#155, ADR-0155 §4). The IO orchestrator that runs an offline eval suite
 * for an agent domain and turns the result into durable maintenance signal:
 *   1. resolve the governed values the suite's metric questions need (a workspace-scoped seam),
 *   2. grade the suite through the pure offline answerer (`corpus.ts`) — no model spend,
 *   3. compare against the committed baseline (`regression.ts`),
 *   4. persist an `eval_runs` row (skill version, git SHA, model id, pass/fail, tokens),
 *   5. log the run to Braintrust via a tracer seam (no-op without a key / when egress is blocked),
 *   6. on a regression, feed a `eval_regression` failure to the #117 flywheel (dedup → issue → fix),
 *   7. on a held/improved run, optionally accrue to the `accumulatedEvals` moat dimension (#103).
 *
 * All governed logic is pure (`grade`/`regression`/`corpus`); every side effect is an injected seam, so a
 * test drives the whole loop over fakes. `caps.enabled` gates only the proactive tick + flywheel feed — a
 * run always grades + persists (recording is harmless), the same always-on/gated split as #117/#119.
 */

import { runSuiteCases, type AnswerContext } from "./corpus.js";
import { summarizeRun, compareRuns, type EvalBaselineEntry, type RegressionVerdict } from "./regression.js";
import { evalAccrualMagnitude } from "./moat.js";
import type { EvalRunRecord, EvalRunSummary, EvalSuite } from "./types.js";
import type { ResolvedMetric } from "../semantic/answer.js";
import type { FleetCaps } from "../semantic/caps.js";

/** Persist seam — the `eval_runs` audit row. */
export interface EvalRunStore {
  insert(input: {
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
    regressed: boolean;
  }): Promise<EvalRunRecord>;
}

/** Braintrust (or any) tracer seam — logs one run span. No-op by default. */
export interface EvalTracer {
  logRun(input: { workspaceId: string; summary: EvalRunSummary; gitSha: string; modelId: string }): Promise<void>;
}

/** The #117 flywheel feed — a regression becomes an `eval_regression` failure event. */
export interface RegressionSink {
  record(input: { workspaceId: string; agent: string; message: string; detail: string }): Promise<void>;
}

/** The #103 moat accrual seam — a held/improved suite widens the `accumulatedEvals` dimension. */
export interface MoatAccrualSink {
  accrue(input: { workspaceId: string; magnitude: number; detail: string }): Promise<void>;
}

export interface EvalServiceDeps {
  store: EvalRunStore;
  /** Resolve one governed metric value for a workspace (the semantic-layer seam). */
  resolveMetric(workspaceId: string, metricId: string): Promise<ResolvedMetric>;
  /** Concatenated knowledge + runbook text for an agent (for the skill-invariant checks). */
  skillText(agent: string): string;
  /** The committed baseline pass-rate for an agent (the before side of the delta). */
  baselineFor(agent: string): EvalBaselineEntry | undefined;
  caps: (workspaceId: string) => FleetCaps;
  tracer?: EvalTracer;
  regressionSink?: RegressionSink;
  moatSink?: MoatAccrualSink;
  /** The git SHA + model id stamped on the run (env-sourced in the default wiring). */
  gitSha?: string;
  modelId?: string;
  now?: () => Date;
}

/** The full outcome of one suite run — surfaced to the route + the CI delta. */
export interface EvalRunOutcome {
  summary: EvalRunSummary;
  verdict: RegressionVerdict;
  record: EvalRunRecord;
}

export class EvalService {
  private readonly deps: EvalServiceDeps;
  private readonly now: () => Date;

  constructor(deps: EvalServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Run + grade + persist + (gated) feed one suite for a workspace. */
  async runSuite(workspaceId: string, suite: EvalSuite): Promise<EvalRunOutcome> {
    const caps = this.deps.caps(workspaceId);
    const nowMs = this.now().getTime();

    // Pre-resolve every governed value the suite's metric cases need, so the pure answerer's `resolve`
    // stays synchronous. Skill cases need no resolution.
    const metricIds = [...new Set(suite.cases.filter((c) => c.kind === "metric" && c.metricId).map((c) => c.metricId!))];
    const resolved = new Map<string, ResolvedMetric>();
    for (const id of metricIds) resolved.set(id, await this.deps.resolveMetric(workspaceId, id));

    const ctx: AnswerContext = {
      nowMs,
      maxAgeMs: caps.freshnessMaxAgeMs,
      resolve: (id) => resolved.get(id) ?? { value: null, asOfMs: null, path: "raw_data" },
      skillText: (agent) => this.deps.skillText(agent),
    };

    const summary = summarizeRun(suite.agent, suite.version, runSuiteCases(suite, ctx));
    const verdict = compareRuns(this.deps.baselineFor(suite.agent), summary, caps.evalRegressionTolerance);

    const record = await this.deps.store.insert({
      workspaceId,
      agent: suite.agent,
      suiteVersion: suite.version,
      gitSha: this.deps.gitSha ?? "",
      modelId: this.deps.modelId ?? "",
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      passRate: summary.passRate,
      tokens: 0, // offline, deterministic suite — no model tokens spent
      regressed: verdict.regressed,
    });

    // Best-effort external trace (Braintrust); never blocks the run.
    await this.deps.tracer?.logRun({ workspaceId, summary, gitSha: record.gitSha, modelId: record.modelId }).catch(() => {});

    // A regression feeds the flywheel — but only when the proactive posture is enabled (default OFF), so a
    // demo/CI workspace records the run without spawning fix agents.
    if (verdict.regressed && caps.enabled && this.deps.regressionSink) {
      const failed = summary.results.filter((r) => !r.passed).map((r) => r.caseId);
      await this.deps.regressionSink.record({
        workspaceId,
        agent: suite.agent,
        message: `eval regression: ${suite.agent} skills dropped to ${(summary.passRate * 100).toFixed(1)}% (baseline ${(verdict.baselineRate * 100).toFixed(1)}%)`,
        detail: `suite ${suite.agent}@${suite.version}; failed cases: ${failed.join(", ") || "(none)"}`,
      });
    }

    // A held/improved suite widens the moat (accumulatedEvals). Gated like the flywheel feed.
    if (!verdict.regressed && caps.enabled && this.deps.moatSink) {
      const magnitude = evalAccrualMagnitude(summary);
      if (magnitude > 0) {
        await this.deps.moatSink.accrue({
          workspaceId,
          magnitude,
          detail: `eval suite ${suite.agent}@${suite.version} held at ${(summary.passRate * 100).toFixed(1)}%`,
        });
      }
    }

    return { summary, verdict, record };
  }
}
