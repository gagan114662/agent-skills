import { describe, it, expect } from "vitest";
import type { TeamEvent } from "@reload/shared";
import { encodeTeamEvent, tryParseTeamEvent } from "../../src/team/protocol.js";
import { TeamCoordinator, type TeamLauncher } from "../../src/team/coordinator.js";
import { TeamChannel } from "../../src/team/channel.js";
import type { LaunchInput, SessionLogger } from "../../src/runtime/manager.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** In-memory team channel: records posted messages and replays them for readRecentEvents. */
function makeChannel(): { channel: TeamChannel; events: () => TeamEvent[]; postBody: (body: string) => void } {
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
  const postBody = (body: string) => {
    posted.push({ body });
  };
  return { channel, events, postBody };
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

const scoutResearchEvent: TeamEvent = {
  teamRunId: "run_1",
  subtaskId: "scout",
  agentMemberId: "mem_scout",
  kind: "milestone",
  summary: "research artifact ready: acme.test",
  branch: "b-scout",
  createdAt: "2026-06-08T00:00:00.000Z",
  artifact: {
    kind: "scout_research",
    schemaVersion: 1,
    siteSummary: "Acme sells compliance workflow software.",
    icp: "RevOps leaders at regulated B2B companies",
    positioning: "A clean audit trail without spreadsheet wrangling.",
    proofPoints: ["SOC2 page mentions audit exports", "Pricing page names RevOps"],
    competitors: ["spreadsheet process", "legacy GRC suite"],
    toneNotes: "Plain, direct, low-drama.",
    sourceUrls: ["https://acme.test"],
  },
};

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

  it("runs higher phases only after earlier phases finish (#1536)", async () => {
    const launched: string[] = [];
    const joined: string[] = [];
    const launcher: TeamLauncher = {
      async launch(input) {
        launched.push(input.task);
        return { id: input.task };
      },
      async join(id) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        joined.push(id);
      },
    };
    const { channel } = makeChannel();
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 4,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    await coordinator.runTeam({
      ...runInput(4),
      subtasks: [
        { subtaskId: "scout", agentMemberId: "mem_scout", task: "scout", branch: "b-scout", phase: 1 },
        { subtaskId: "quill", agentMemberId: "mem_quill", task: "quill", branch: "b-quill", phase: 1 },
        { subtaskId: "echo", agentMemberId: "mem_echo", task: "echo", branch: "b-echo", phase: 2 },
        { subtaskId: "lens", agentMemberId: "mem_lens", task: "lens", branch: "b-lens", phase: 3 },
      ],
    });

    expect(new Set(launched.slice(0, 2))).toEqual(new Set(["scout", "quill"]));
    expect(launched.indexOf("echo")).toBeGreaterThan(launched.indexOf("quill"));
    expect(launched.indexOf("lens")).toBeGreaterThan(launched.indexOf("echo"));
    expect(joined).toEqual(expect.arrayContaining(["scout", "quill", "echo", "lens"]));
  });

  it("blocks a writer before launch when required Scout research is missing (#1540)", async () => {
    const launcher = new FakeLauncher();
    const { channel, events } = makeChannel();
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 1,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    const result = await coordinator.runTeam({
      ...runInput(1),
      subtasks: [
        {
          subtaskId: "quill",
          agentMemberId: "mem_quill",
          task: "draft launch copy",
          branch: "b-quill",
          requiresArtifacts: ["scout_research"],
        },
      ],
    });

    expect(launcher.launched).toHaveLength(0);
    expect(result.results[0]).toMatchObject({
      subtaskId: "quill",
      ok: false,
      error: "blocked: missing required artifact: Scout research artifact",
    });
    expect(events().find((event) => event.kind === "blocked")?.summary).toBe(
      "blocked: missing required artifact: Scout research artifact",
    );
  });

  it("injects validated Scout research into downstream writer tasks (#1540)", async () => {
    const launcher = new FakeLauncher();
    const { channel } = makeChannel();
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: scoutResearchEvent });
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 1,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    await coordinator.runTeam({
      ...runInput(1),
      subtasks: [
        {
          subtaskId: "quill",
          agentMemberId: "mem_quill",
          task: "draft launch copy",
          branch: "b-quill",
          requiresArtifacts: ["scout_research"],
        },
      ],
    });

    expect(launcher.launched).toHaveLength(1);
    expect(launcher.launched[0]?.task).toContain("Required upstream team artifacts");
    expect(launcher.launched[0]?.task).toContain("Acme sells compliance workflow software.");
    expect(launcher.launched[0]?.task).toContain("SOC2 page mentions audit exports");
    expect(launcher.launched[0]?.task).toContain("Every draft you produce must cite");
    expect(launcher.launched[0]?.task).toContain("draft launch copy");
  });

  it("accepts Scout research from a raw persisted agent marker message (#1540)", async () => {
    const launcher = new FakeLauncher();
    const { channel, postBody } = makeChannel();
    postBody(encodeTeamEvent(scoutResearchEvent));
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 1,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    await coordinator.runTeam({
      ...runInput(1),
      subtasks: [
        {
          subtaskId: "quill",
          agentMemberId: "mem_quill",
          task: "draft launch copy",
          branch: "b-quill",
          requiresArtifacts: ["scout_research"],
        },
      ],
    });

    expect(launcher.launched[0]?.task).toContain("Required upstream team artifacts");
    expect(launcher.launched[0]?.task).toContain("sourceUrls");
  });

  it("adds exact Scout research artifact production instructions to producer tasks (#1540)", async () => {
    const launcher = new FakeLauncher();
    const { channel } = makeChannel();
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 1,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    await coordinator.runTeam({
      ...runInput(1),
      subtasks: [
        {
          subtaskId: "scout",
          agentMemberId: "mem_scout",
          task: "research acme.test",
          branch: "b-scout",
          producesArtifacts: ["scout_research"],
        },
      ],
    });

    expect(launcher.launched[0]?.task).toContain("Required team artifact production contract");
    expect(launcher.launched[0]?.task).toContain('"teamRunId": "run_1"');
    expect(launcher.launched[0]?.task).toContain('"subtaskId": "scout"');
    expect(launcher.launched[0]?.task).toContain('"kind": "scout_research"');
    expect(launcher.launched[0]?.task).toContain("research acme.test");
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

  it("keeps structured room packets out of lifecycle event summaries (#1265)", async () => {
    const launcher = new FakeLauncher();
    const { channel, events } = makeChannel();
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 2,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });
    const scoutPacket = [
      "1. Task context",
      "You are Scout in ipop's live marketing room. Work on the owner's current growth goal: grow ipop.ai. Your lane is insight mining.",
      "2. Tone context",
      "Warm, plain, sharp, and useful.",
    ].join("\n");
    const operatorPacket = [
      "codex_work_packet",
      "audit_label: codex_operator_lane",
      "1. Task context",
      "You are Codex in ipop's live marketing room. Work on the owner's current growth goal: grow ipop.ai. Your lane is codex_operator_lane.",
      "9. Output formatting",
      "- pr_or_issue_links",
    ].join("\n");

    await coordinator.runTeam({
      ...runInput(2),
      subtasks: [
        {
          subtaskId: "scout",
          agentMemberId: "mem_scout",
          task: scoutPacket,
          branch: "ipop-scout-grow-ipop-ai",
        },
        {
          subtaskId: "operator",
          agentMemberId: "mem_operator",
          task: operatorPacket,
          branch: "ipop-codex-grow-ipop-ai",
          preferredHarness: "codex",
        },
      ],
    });

    expect(launcher.launched[0]?.task).toBe(scoutPacket);
    expect(launcher.launched[1]?.task).toBe(operatorPacket);
    const summaries = events().map((event) => event.summary);
    expect(summaries).toContain("started: Scout insight mining");
    expect(summaries).toContain("done: Scout insight mining");
    expect(summaries).toContain("started: Codex operator lane");
    expect(summaries).toContain("done: Codex operator lane");
    expect(summaries.join("\n")).not.toContain("2. Tone context");
    expect(summaries.join("\n")).not.toContain("9. Output formatting");
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
