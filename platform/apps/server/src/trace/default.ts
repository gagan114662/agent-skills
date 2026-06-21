import { TraceService, type TraceDeps } from "./service.js";
import {
  openTraceRun,
  appendTraceEvent,
  closeTraceRun,
  getTraceRun,
  listTraceEvents,
  listTraceRuns,
} from "../db/repositories/agent-trace.js";
import { resolveAllServiceSecrets } from "../db/repositories/external-credentials.js";
import { getWorkspaceClaudeToken } from "../db/repositories/agent-credentials.js";

/**
 * Bind the {@link TraceService} seams to the real repos (issue #560). `secretsForRun` reuses the EXISTING
 * secret sources — the #192 external-credential vault (`resolveAllServiceSecrets`) and the workspace Claude
 * token — so every value the runtime could have injected as env (and that could therefore leak back into a
 * traced payload) is masked before persist, with no new secret store. Best-effort: if secret resolution
 * fails, the trace still records with the key-scrubber active rather than dropping the event.
 */
export function createDefaultTraceService(): TraceService {
  const deps: TraceDeps = {
    secretsForRun: async (workspaceId) => {
      try {
        const env = await resolveAllServiceSecrets(workspaceId);
        const values = Object.values(env);
        const claudeToken = await getWorkspaceClaudeToken(workspaceId);
        if (claudeToken) values.push(claudeToken);
        return values;
      } catch {
        return [];
      }
    },
    openRun: (input) => openTraceRun(input),
    appendEvent: (input) => appendTraceEvent(input),
    closeRun: (workspaceId, runId) => closeTraceRun(workspaceId, runId),
    getRun: (workspaceId, runId) => getTraceRun(workspaceId, runId),
    listEvents: (workspaceId, runId) => listTraceEvents(workspaceId, runId),
    listRuns: (workspaceId, filter) => listTraceRuns(workspaceId, filter),
  };
  return new TraceService(deps);
}
