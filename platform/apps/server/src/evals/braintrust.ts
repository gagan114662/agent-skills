/**
 * Braintrust-backed eval tracer (#155, ADR-0155 §4). Logs one span per eval-suite run — the agent + suite
 * version as input, the pass-rate + failed-case ids as output — so skill-maintenance runs are observable in
 * the Braintrust project dashboard alongside the agent sessions (`observability/braintrust.ts`). Mirrors
 * that module's gating exactly: a no-op tracer unless `BRAINTRUST_API_KEY` is set AND egress is allowed
 * (#58 data-privacy mode is the hard gate), so local dev, CI, and unit tests never call out.
 */

import { initLogger, traced } from "braintrust";
import { egressAllowed } from "../config/egress.js";
import type { EvalTracer } from "./service.js";

/** A tracer that does nothing — the default in CI / without a key / under data-privacy mode. */
export const noopEvalTracer: EvalTracer = {
  async logRun() {
    /* no-op */
  },
};

let loggerReady = false;

export function createBraintrustEvalTracer(opts: { dataPrivacyMode?: boolean } = {}): EvalTracer {
  if (!egressAllowed({ dataPrivacyMode: opts.dataPrivacyMode ?? false })) return noopEvalTracer;
  if (!process.env.BRAINTRUST_API_KEY) return noopEvalTracer;
  const projectName = process.env.BRAINTRUST_PROJECT ?? "My Project";
  if (!loggerReady) {
    initLogger({ projectName });
    loggerReady = true;
  }
  return {
    async logRun({ workspaceId, summary, gitSha, modelId }) {
      await traced(
        async (span) => {
          span.log({
            input: `eval ${summary.agent}@${summary.version}`,
            output: `passRate=${summary.passRate.toFixed(3)} (${summary.passed}/${summary.total})`,
            metadata: {
              workspaceId,
              agent: summary.agent,
              suiteVersion: summary.version,
              gitSha,
              modelId,
              failedCases: summary.results.filter((r) => !r.passed).map((r) => r.caseId),
            },
          });
        },
        { name: "eval_run" },
      );
    },
  };
}
