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
  /** Team Mode: the run this session belongs to, so the dashboard can group it with its peers. */
  teamRunId?: string;
  /** Team Mode: the team rollup span this session links under (Braintrust parent span id). */
  parentSpanId?: string;
}

/** The session result, recorded as the span's output. */
export interface AgentSessionOutcome {
  status: string;
  exitCode: number | null;
  result: string | null;
}

/** Identifying context for a team rollup span (Team Mode): one parent span over N child sessions. */
export interface TeamTrace {
  teamRunId: string;
  workspaceId: string;
  channelId: string;
  subtaskCount: number;
}

/** The aggregate result of a team run, recorded as the team span's output. */
export interface TeamOutcome {
  completed: number;
  failed: number;
}

/**
 * Context handed to the team-span body. `parentSpanId` is the rollup span's id; the coordinator
 * threads it into each child session trace so the child `agent_session` spans link under the team.
 */
export interface TeamSpanContext {
  parentSpanId?: string;
}

/** Wraps the driven lifecycle of a single agent session so it is observable as one span. */
export interface AgentTracer {
  session(
    trace: AgentSessionTrace,
    run: () => Promise<AgentSessionOutcome>,
  ): Promise<AgentSessionOutcome>;
  /**
   * Team Mode: wrap a whole team run in one rollup span that links its child sessions. Optional so
   * existing tracers stay valid; callers fall back to running without a team span when unset.
   */
  team?(
    trace: TeamTrace,
    run: (ctx: TeamSpanContext) => Promise<TeamOutcome>,
  ): Promise<TeamOutcome>;
}

/** Default tracer — runs the session/team and records nothing. Used everywhere tracing is disabled. */
export const noopTracer: AgentTracer = {
  session: (_trace, run) => run(),
  team: (_trace, run) => run({}),
};
