import { describe, it, expect } from "vitest";
import type { TeamEvent } from "@reload/shared";
import { tryParseTeamEvent } from "../../src/team/protocol.js";
import { TeamCoordinator, type TeamLauncher } from "../../src/team/coordinator.js";
import { TeamChannel } from "../../src/team/channel.js";
import type { LaunchInput, SessionLogger } from "../../src/runtime/manager.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** In-memory team channel: records posted events and replays them for readRecentEvents. */
function makeChannel(): { channel: TeamChannel; events: () => TeamEvent[] } {
  const posted: { body: string }[] = [];
  const channel = new TeamChannel({
    poster: {
      post: (input) => {
        posted.push({ body: input.body });
        return Promise.resolve({ id: `m${posted.length}` });
      },
    },
    publish: () => Promise.resolve(),
    listMessages: () => Promise.resolve(posted),
  });
  const events = () =>
    posted.map((p) => tryParseTeamEvent(p.body)).filter((e): e is TeamEvent => !!e);
  return { channel, events };
}

/**
 * A launcher whose join() stays in flight for one macrotask, so overlapping launches are
 * observable. `failOn` makes launch() throw for a given subtask task, to exercise failure
 * isolation. Records the peak number of concurrently-joined sessions.
 */
class FakeLauncher implements TeamLauncher {
  active = 0;
  peak = 0;
  launched: LaunchInput[] = [];
  constructor(private readonly failOn?: (input: LaunchInput) => boolean) {}

  launch(input: LaunchInput): Promise<{ id: string }> {
    this.launched.push(input);
    if (this.failOn?.(input)) return Promise.reject(new Error(`boom: ${input.task}`));
    return Promise.resolve({ id: `s${this.launched.length}` });
  }

  join(): Promise<void> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        this.active -= 1;
        resolve();
      }, 5),
    );
  }
}

const subtasks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    subtaskId: `sub_${i}`,
    agentMemberId: `mem_${i}`,
    task: `do part ${i}`,
    branch: `feat/part-${i}`,
  }));

const runInput = (n: number) => ({
  workspaceId: "ws_1",
  channelId: "ch_1",
  createdByMemberId: "mem_human",
  teamRunId: "run_1",
  subtasks: subtasks(n),
});

describe("TeamCoordinator (#TeamMode — parallel run, concurrency cap, failure isolation)", () => {
  it("never exceeds the max-concurrency cap", async () => {
    const launcher = new FakeLauncher();
    const { channel } = makeChannel();
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 2,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    const result = await coordinator.runTeam(runInput(5));

    expect(launcher.launched).toHaveLength(5);
    expect(launcher.peak).toBe(2); // 5 subtasks, but at most 2 sessions in flight at once
    expect(result.results.every((r) => r.ok)).toBe(true);
  });

  it("runs all subtasks when the cap exceeds the subtask count (no idle workers)", async () => {
    const launcher = new FakeLauncher();
    const { channel, events } = makeChannel();
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 10,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    await coordinator.runTeam(runInput(3));

    expect(launcher.peak).toBe(3); // bounded by subtask count, not the cap
    // Each subtask emits a started + done event on the channel.
    const kinds = events().map((e) => e.kind);
    expect(kinds.filter((k) => k === "started")).toHaveLength(3);
    expect(kinds.filter((k) => k === "done")).toHaveLength(3);
  });

  it("isolates a failing subtask — its peers still complete", async () => {
    const launcher = new FakeLauncher((input) => input.task === "do part 1");
    const { channel, events } = makeChannel();
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 3,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    const result = await coordinator.runTeam(runInput(3));

    const failed = result.results.filter((r) => !r.ok);
    const ok = result.results.filter((r) => r.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.subtaskId).toBe("sub_1");
    expect(failed[0]?.error).toContain("boom");
    expect(ok).toHaveLength(2); // the other two ran to completion
    expect(ok.map((r) => r.sessionId).every(Boolean)).toBe(true);

    // The failure is announced as a `blocked` event so peers can see it.
    const blocked = events().filter((e) => e.kind === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.subtaskId).toBe("sub_1");
  });

  it("threads teamRunId + parentSpanId into each launch (observability linkage)", async () => {
    const launcher = new FakeLauncher();
    const { channel } = makeChannel();
    // A tracer whose team() supplies a parent span id, mimicking the Braintrust rollup.
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 5,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
      tracer: {
        session: (_t, run) => run(),
        team: (_t, run) => run({ parentSpanId: "span_parent" }),
      },
    });

    await coordinator.runTeam(runInput(2));

    expect(launcher.launched.every((l) => l.teamRunId === "run_1")).toBe(true);
    expect(launcher.launched.every((l) => l.parentSpanId === "span_parent")).toBe(true);
  });

  it("passes Codex operator subtasks through the real codex harness", async () => {
    const launcher = new FakeLauncher();
    const { channel } = makeChannel();
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 2,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    await coordinator.runTeam({
      ...runInput(1),
      subtasks: [
        {
          subtaskId: "codex_operator",
          agentMemberId: "mem_codex",
          task: "Build the approved iMessage-first homepage and verify it.",
          branch: "feat/codex-operator",
          preferredHarness: "codex",
        },
      ],
    });

    expect(launcher.launched[0]?.harness).toBe("codex");
    expect(launcher.launched[0]?.task).toContain("iMessage-first");
  });

  it("readEvents returns the channel's parsed team events", async () => {
    const launcher = new FakeLauncher();
    const { channel } = makeChannel();
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 2,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    await coordinator.runTeam(runInput(2));
    const seen = await coordinator.readEvents("ch_1");
    expect(seen.length).toBeGreaterThanOrEqual(4); // 2 started + 2 done
    expect(seen.every((e) => e.teamRunId === "run_1")).toBe(true);
  });

  it("queues and retries announcement persistence failures before peers read events", async () => {
    const launcher = new FakeLauncher();
    const posted: { body: string }[] = [];
    let failPosts = 1;
    const channel = new TeamChannel({
      poster: {
        post: (input) => {
          if (failPosts > 0) {
            failPosts -= 1;
            return Promise.reject(new Error("database unavailable"));
          }
          posted.push({ body: input.body });
          return Promise.resolve({ id: `m${posted.length}` });
        },
      },
      publish: () => Promise.resolve(),
      listMessages: () => Promise.resolve(posted),
    });
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 1,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    const result = await coordinator.runTeam(runInput(1));

    expect(result.visibilityDegraded).toBe(true);
    expect(result.results[0]?.visibilityDegraded).toBe(true);
    const seen = await coordinator.readEvents("ch_1");
    expect(seen.map((e) => e.kind)).toEqual(["started", "done"]);
  });
});
