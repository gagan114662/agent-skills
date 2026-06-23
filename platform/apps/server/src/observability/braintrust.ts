import { initLogger, traced } from "braintrust";
import { noopTracer, type AgentTracer } from "./tracing.js";
import { egressAllowed } from "../config/egress.js";
import { redactPotentialSecrets } from "../runtime/redact.js";

/**
 * Braintrust-backed agent tracer (https://braintrust.dev). Every agent session becomes one span —
 * the launch task as the input, the run's result/status as the output — so the agents that build
 * on the platform are observable in the Braintrust project dashboard.
 *
 * Returns a no-op tracer when `BRAINTRUST_API_KEY` is unset, so local dev, CI, and unit tests never
 * call out to Braintrust. This is wired into the production SessionManager in `runtime/default.ts`.
 *
 * Env:
 *   BRAINTRUST_API_KEY — required to enable tracing (the SDK reads it from the environment).
 *   BRAINTRUST_PROJECT — the project to log under (default "My Project").
 */
let loggerReady = false;

/**
 * @param opts.dataPrivacyMode — when on (#58), force the no-op tracer so no agent task/result is
 * exported off-platform, regardless of `BRAINTRUST_API_KEY`.
 */
export function createBraintrustTracer(opts: { dataPrivacyMode?: boolean } = {}): AgentTracer {
  // Data-privacy mode is the hard gate: no external trace export when egress is disallowed.
  if (!egressAllowed({ dataPrivacyMode: opts.dataPrivacyMode ?? false })) return noopTracer;
  if (!process.env.BRAINTRUST_API_KEY) return noopTracer;
  const projectName = process.env.BRAINTRUST_PROJECT ?? "My Project";
  if (!loggerReady) {
    initLogger({ projectName });
    loggerReady = true;
  }
  return {
    session(trace, run) {
      return traced(
        async (span) => {
          const outcome = await run();
          span.log({
            input: redactPotentialSecrets(trace.task),
            output: redactPotentialSecrets(outcome.result ?? ""),
            metadata: {
              sessionId: trace.sessionId,
              workspaceId: trace.workspaceId,
              agentMemberId: trace.agentMemberId,
              runtime: trace.runtime,
              status: outcome.status,
              exitCode: outcome.exitCode,
              // Team Mode: tag the run so child sessions are filterable/groupable as one team.
              ...(trace.teamRunId ? { teamRunId: trace.teamRunId } : {}),
            },
          });
          return outcome;
        },
        // Team Mode: when launched under a team run, attach this session as a child of the team
        // rollup span (`parentSpanId` is the exported parent span). Plain sessions pass undefined.
        { name: "agent_session", parent: trace.parentSpanId },
      );
    },
    team(trace, run) {
      return traced(
        async (span) => {
          // Export the team span so the coordinator can link each child session under it.
          const parentSpanId = await span.export();
          const outcome = await run({ parentSpanId });
          span.log({
            input: redactPotentialSecrets(
              "team run " + trace.teamRunId + " (" + trace.subtaskCount + " subtasks)",
            ),
            output: `completed=${outcome.completed} failed=${outcome.failed}`,
            metadata: {
              teamRunId: trace.teamRunId,
              workspaceId: trace.workspaceId,
              channelId: trace.channelId,
              subtaskCount: trace.subtaskCount,
              completed: outcome.completed,
              failed: outcome.failed,
            },
          });
          return outcome;
        },
        { name: "team_session" },
      );
    },
  };
}
