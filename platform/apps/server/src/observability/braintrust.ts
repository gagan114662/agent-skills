import { initLogger, traced } from "braintrust";
import { noopTracer, type AgentTracer } from "./tracing.js";

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

export function createBraintrustTracer(): AgentTracer {
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
            input: trace.task,
            output: outcome.result ?? "",
            metadata: {
              sessionId: trace.sessionId,
              workspaceId: trace.workspaceId,
              agentMemberId: trace.agentMemberId,
              runtime: trace.runtime,
              status: outcome.status,
              exitCode: outcome.exitCode,
            },
          });
          return outcome;
        },
        { name: "agent_session" },
      );
    },
  };
}
