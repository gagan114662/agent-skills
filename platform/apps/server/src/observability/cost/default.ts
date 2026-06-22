import { CostObservabilityService, type CostDeps } from "./service.js";
import type { RunCostEventRow } from "./rollup.js";
import { getRunCostRow, listRunCostRows } from "../../db/repositories/agent-trace-cost.js";
import { listTraceEvents } from "../../db/repositories/agent-trace.js";

/**
 * Bind the {@link CostObservabilityService} seams to the real #560 trace repos (issue #667). Read-only: it
 * reuses the existing run header rollup (`agent_trace_runs`) and the append-only event log — no new tables,
 * no migration. `listRunEvents` maps the full trace event rows down to just the cost fields the breakdown
 * needs, keeping payloads (already redacted at the write site) out of the cost path entirely.
 */
export function createDefaultCostService(): CostObservabilityService {
  const deps: CostDeps = {
    getRun: (workspaceId, runId) => getRunCostRow(workspaceId, runId),
    listRunEvents: async (workspaceId, runId): Promise<RunCostEventRow[]> => {
      const events = await listTraceEvents(workspaceId, runId);
      return events.map((e) => ({
        type: e.type,
        label: e.label,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        costMicros: e.costMicros,
      }));
    },
    listRunsInWindow: (workspaceId, window) => listRunCostRows(workspaceId, window),
  };
  return new CostObservabilityService(deps);
}
