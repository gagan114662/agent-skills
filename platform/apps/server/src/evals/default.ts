/**
 * Production wiring for eval-gated maintenance (#155, ADR-0155 §4). Binds the pure eval core to real seams:
 * the `eval_runs` repo, the SAME governed metric resolver lens uses (so an eval grades through the real
 * semantic path), the on-disk skill text + committed baseline (loader), the Braintrust tracer (gated), and
 * — when an engine is supplied — the #117 flywheel as the regression sink (a regression becomes an
 * `eval_regression` failure event). The moat sink is intentionally left unset: the `accumulatedEvals`
 * accrual is fleet-level, but `moat_ledger` is venture-scoped today, so that prod wiring waits on a
 * fleet-scoped ledger (the seam + pure `evalAccrualMagnitude` are tested via a fake).
 */

import { EvalService } from "./service.js";
import { createBraintrustEvalTracer } from "./braintrust.js";
import { loadSkillText, loadBaseline } from "./loader.js";
import { resolveFleetCaps } from "../semantic/caps.js";
import { createDefaultMetricResolver } from "../semantic/default.js";
import { getMetric } from "../semantic/catalog.js";
import { loadConfig } from "../config/loader.js";
import { insertEvalRun } from "../db/repositories/evals.js";
import type { FlywheelEngine } from "../flywheel/engine.js";

export function createDefaultEvalService(opts: { flywheel?: FlywheelEngine } = {}): EvalService {
  const resolver = createDefaultMetricResolver();
  const baseline = loadBaseline();

  return new EvalService({
    store: { insert: insertEvalRun },
    resolveMetric: (workspaceId, metricId) => {
      const def = getMetric(metricId);
      return def
        ? resolver.resolve(workspaceId, def)
        : Promise.resolve({ value: null, asOfMs: null, path: "raw_data" as const });
    },
    skillText: (agent) => loadSkillText(agent),
    baselineFor: (agent) => baseline.agents[agent],
    caps: (workspaceId) => resolveFleetCaps(loadConfig(workspaceId).fleet),
    tracer: createBraintrustEvalTracer(),
    // A regression feeds the flywheel as an `eval_regression` failure (dedup → issue → fix). Only wired
    // when an engine is available (app.ts); the run still persists + traces without it.
    regressionSink: opts.flywheel
      ? {
          record: async ({ workspaceId, agent, message, detail }) => {
            await opts.flywheel!.record({
              workspaceId,
              failureClass: "eval_regression",
              message,
              detail,
              source: `evals:${agent}`,
            });
          },
        }
      : undefined,
    gitSha: process.env.GIT_SHA ?? process.env.GITHUB_SHA ?? "",
    modelId: process.env.ANTHROPIC_MODEL ?? "",
  });
}
