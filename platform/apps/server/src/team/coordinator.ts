import type { TeamEvent, TeamEventKind } from "@reload/shared";
import type { LaunchInput, SessionLogger } from "../runtime/manager.js";
import {
  noopTracer,
  type AgentTracer,
  type TeamSpanContext,
  type TeamTrace,
} from "../observability/tracing.js";
import type { TeamChannel } from "./channel.js";

/**
 * The launch surface the coordinator drives. {@link SessionManager} satisfies this structurally —
 * `launch` returns immediately (the run continues server-side) and `join` awaits completion. Tests
 * inject a fake to assert the concurrency cap and failure isolation without a runtime or DB.
 */
export interface TeamLauncher {
  launch(input: LaunchInput): Promise<{ id: string }>;
  join(id: string): Promise<void>;
}

/** One unit of parallel work in a team run: an agent, its prompt, and the branch it owns. */
export interface Subtask {
  /** Stable id for this subtask within the run (used in every team event). */
  subtaskId: string;
  /** The agent member that will execute it (and author its team events). */
  agentMemberId: string;
  /** The task/prompt handed to the agent (passed to the harness as data). */
  task: string;
  /** The branch the agent works on — recorded on the subtask's team events. */
  branch: string;
}

export interface TeamRunInput {
  workspaceId: string;
  channelId: string;
  createdByMemberId: string;
  /** Unique id grouping every session + event of this run. */
  teamRunId: string;
  subtasks: Subtask[];
}

/** Per-subtask outcome (the run as a whole never rejects — failures are isolated and reported). */
export interface SubtaskResult {
  subtaskId: string;
  sessionId: string | null;
  ok: boolean;
  error?: string;
}

export interface TeamRunResult {
  teamRunId: string;
  results: SubtaskResult[];
}

export interface TeamCoordinatorDeps {
  launcher: TeamLauncher;
  channel: TeamChannel;
  /** Max sessions in flight at once — the team-level cap that keeps us under the sandbox budget. */
  maxConcurrency: number;
  logger: SessionLogger;
  /** Observability seam; defaults to the no-op so tests/CI never touch the network. */
  tracer?: AgentTracer;
  /** Injectable clock for deterministic event timestamps in tests. */
  now?: () => string;
}

/**
 * TeamCoordinator — runs N agents in parallel on one feature, each on its own subtask/branch,
 * keeping them in the loop through the shared team channel (Team Mode).
 *
 *   - Concurrency: an async worker pool keeps at most `maxConcurrency` sessions in flight, so we
 *     never exceed the sandbox budget. The existing per-session `ResourceCaps` still apply
 *     unchanged via the underlying SessionManager.
 *   - Failure isolation: each subtask runs independently; one agent failing posts a `blocked`
 *     event and is reported as `{ ok: false }` while the others run to completion. `runTeam` never
 *     rejects.
 *   - Observability: the whole run is wrapped in one team rollup span; each child session links
 *     under it (via `parentSpanId`) so the run reviews as one team in Braintrust.
 */
export class TeamCoordinator {
  private readonly tracer: AgentTracer;
  private readonly now: () => string;

  constructor(private readonly deps: TeamCoordinatorDeps) {
    this.tracer = deps.tracer ?? noopTracer;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async runTeam(input: TeamRunInput): Promise<TeamRunResult> {
    const results: SubtaskResult[] = new Array<SubtaskResult>(input.subtasks.length);

    const body = async (ctx: TeamSpanContext): Promise<{ completed: number; failed: number }> => {
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = next++;
          const subtask = input.subtasks[i];
          if (!subtask) return;
          results[i] = await this.runSubtask(input, subtask, ctx.parentSpanId);
        }
      };
      // At most `maxConcurrency` sessions in flight; never spawn more workers than subtasks.
      const workers = Math.max(1, Math.min(this.deps.maxConcurrency, input.subtasks.length));
      await Promise.all(Array.from({ length: workers }, () => worker()));
      const completed = results.filter((r) => r.ok).length;
      return { completed, failed: results.length - completed };
    };

    const trace: TeamTrace = {
      teamRunId: input.teamRunId,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      subtaskCount: input.subtasks.length,
    };
    // Wrap the run in the team rollup span when the tracer supports it; otherwise run plainly.
    if (this.tracer.team) {
      await this.tracer.team(trace, body);
    } else {
      await body({});
    }
    return { teamRunId: input.teamRunId, results };
  }

  /** Read a channel's recent team events (peers catching up before they act). */
  readEvents(channelId: string, opts?: { limit?: number }): Promise<TeamEvent[]> {
    return this.deps.channel.readRecentEvents(channelId, opts);
  }

  /** Drive one subtask end to end, isolating any failure from its peers. */
  private async runSubtask(
    input: TeamRunInput,
    subtask: Subtask,
    parentSpanId: string | undefined,
  ): Promise<SubtaskResult> {
    await this.announce(input, subtask, "started", `started: ${subtask.task}`);
    try {
      const { id } = await this.deps.launcher.launch({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        agentMemberId: subtask.agentMemberId,
        createdByMemberId: input.createdByMemberId,
        task: subtask.task,
        teamRunId: input.teamRunId,
        parentSpanId,
      });
      await this.deps.launcher.join(id);
      await this.announce(input, subtask, "done", `done: ${subtask.task}`);
      return { subtaskId: subtask.subtaskId, sessionId: id, ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.deps.logger.error({ err: error, subtaskId: subtask.subtaskId }, "team subtask failed");
      await this.announce(input, subtask, "blocked", `blocked: ${error}`);
      return { subtaskId: subtask.subtaskId, sessionId: null, ok: false, error };
    }
  }

  /** Post a coordinator-authored lifecycle event to the team channel (best-effort, never fatal). */
  private async announce(
    input: TeamRunInput,
    subtask: Subtask,
    kind: TeamEventKind,
    summary: string,
  ): Promise<void> {
    const event: TeamEvent = {
      teamRunId: input.teamRunId,
      subtaskId: subtask.subtaskId,
      agentMemberId: subtask.agentMemberId,
      kind,
      summary,
      branch: subtask.branch,
      createdAt: this.now(),
    };
    try {
      await this.deps.channel.postEvent({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        event,
      });
    } catch (err) {
      // A notification failure must not break the run — the session itself is the work of record.
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err), kind },
        "team event post failed",
      );
    }
  }
}
