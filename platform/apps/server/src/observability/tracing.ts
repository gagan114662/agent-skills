import type { RuntimeKind } from "../db/repositories/agent-sessions.js";

/**
 * Agent-session tracing seam (#25 runtime observability). Mirrors the SessionManager's other
 * injected seams (store / poster / secrets): the production implementation (Braintrust) wraps each
 * agent session in a span, while tests/CI get the no-op so nothing reaches the network.
 */

/** Identifying context for one agent session span (the span's input + metadata). */
export interface AgentSessionTrace {
  sessionId: string;
  workspaceId: string;
  agentMemberId: string;
  runtime: RuntimeKind;
  /** The task/prompt the agent was launched with — recorded as the span input. */
  task: string;
}

/** The session result, recorded as the span's output. */
export interface AgentSessionOutcome {
  status: string;
  exitCode: number | null;
  result: string | null;
}

/** Wraps the driven lifecycle of a single agent session so it is observable as one span. */
export interface AgentTracer {
  session(
    trace: AgentSessionTrace,
    run: () => Promise<AgentSessionOutcome>,
  ): Promise<AgentSessionOutcome>;
}

/** Default tracer — runs the session and records nothing. Used everywhere tracing is disabled. */
export const noopTracer: AgentTracer = {
  session: (_trace, run) => run(),
};
