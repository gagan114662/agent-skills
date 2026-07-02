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

const brandVoiceEvent: TeamEvent = {
  teamRunId: "run_1",
  subtaskId: "scout",
  agentMemberId: "mem_scout",
  kind: "milestone",
  summary: "brand voice ready: acme.test",
  branch: "b-scout",
  createdAt: "2026-06-08T00:00:30.000Z",
  artifact: {
    kind: "brand_voice",
    schemaVersion: 1,
    profile: {
      toneAxes: ["plain over hype", "proof-led over vague"],
      vocabularyDo: ["audit trail", "receipts"],
      vocabularyDont: ["guaranteed", "magic"],
      sentenceRhythm: "Short setup, concrete payoff.",
      exampleLines: ["Acme turns messy spreadsheet approvals into a clean audit trail."],
    },
    sourceUrls: ["https://acme.test"],
  },
};

const draftSetEvent: TeamEvent = {
  teamRunId: "run_1",
  subtaskId: "quill",
  agentMemberId: "mem_quill",
  kind: "milestone",
  summary: "draft set ready: acme.test",
  branch: "b-quill",
  createdAt: "2026-06-08T00:01:00.000Z",
  artifact: {
    kind: "draft_set",
    schemaVersion: 1,
    drafts: [
      {
        format: "email",
        title: "Launch email",
        fields: {
          subject: "Audit trails without chaos",
          preheader: "Acme found the spreadsheet gap.",
          body: "Here is the proof-led draft.",
          cta: "Review the draft",
          plainTextAlt: "Review the proof-led draft.",
        },
        citations: ["SOC2 page mentions audit exports"],
      },
    ],
  },
};

const strongScores = {
  specificityToBusiness: 5,
  hookStrength: 4,
  clarity: 5,
  evidenceUse: 4,
  ctaQuality: 4,
  voiceConsistency: 5,
};

const lensReviewEvent: TeamEvent = {
  teamRunId: "run_1",
  subtaskId: "lens",
  agentMemberId: "mem_lens",
  kind: "milestone",
  summary: "lens review ready: acme.test",
  branch: "b-lens",
  createdAt: "2026-06-08T00:02:00.000Z",
  artifact: {
    kind: "lens_review",
    schemaVersion: 1,
    threshold: 4,
    summary: "The email is proof-led and ready for owner review.",
    reviews: [
      {
        format: "email",
        title: "Launch email",
        scores: strongScores,
        averageScore: 4.5,
        revisionNote: "Tighten the CTA around the review moment.",
      },
    ],
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

  it("adds brand voice profile instructions to Scout producer tasks (#1543)", async () => {
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
          producesArtifacts: ["scout_research", "brand_voice"],
        },
      ],
    });

    expect(launcher.launched[0]?.task).toContain("brand_voice");
    expect(launcher.launched[0]?.task).toContain("toneAxes");
    expect(launcher.launched[0]?.task).toContain('"summary": "brand voice ready: <domain or target>"');
  });

  it("adds channel-native draft validators to Quill producer tasks (#1541)", async () => {
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
          task: "draft channel-native assets",
          branch: "b-quill",
          requiresArtifacts: ["scout_research"],
          producesArtifacts: ["draft_set"],
        },
      ],
    });

    expect(launcher.launched[0]?.task).toContain("draft_set");
    expect(launcher.launched[0]?.task).toContain('"teamRunId": "run_1"');
    expect(launcher.launched[0]?.task).toContain('"subtaskId": "quill"');
    expect(launcher.launched[0]?.task).toContain("google_rsa");
    expect(launcher.launched[0]?.task).toContain("subject <=45");
    expect(launcher.launched[0]?.task).toContain("draft channel-native assets");
  });

  it("blocks Quill before launch when the brand voice profile is missing (#1543)", async () => {
    const launcher = new FakeLauncher();
    const { channel, events } = makeChannel();
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: scoutResearchEvent });
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
          task: "draft channel-native assets",
          branch: "b-quill",
          requiresArtifacts: ["scout_research", "brand_voice"],
          producesArtifacts: ["draft_set"],
        },
      ],
    });

    expect(launcher.launched).toHaveLength(0);
    expect(result.results[0]).toMatchObject({
      subtaskId: "quill",
      ok: false,
      error: "blocked: missing required artifact: Workspace brand voice profile",
    });
    expect(events().find((event) => event.kind === "blocked")?.summary).toBe(
      "blocked: missing required artifact: Workspace brand voice profile",
    );
  });

  it("injects brand voice into Quill and Lens tasks (#1543)", async () => {
    const launcher = new FakeLauncher();
    const { channel } = makeChannel();
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: scoutResearchEvent });
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: brandVoiceEvent });
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: draftSetEvent });
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 1,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    await coordinator.runTeam({
      ...runInput(2),
      subtasks: [
        {
          subtaskId: "quill",
          agentMemberId: "mem_quill",
          task: "draft channel-native assets",
          branch: "b-quill",
          requiresArtifacts: ["scout_research", "brand_voice"],
          producesArtifacts: ["draft_set"],
        },
        {
          subtaskId: "lens",
          agentMemberId: "mem_lens",
          task: "score drafts against voice",
          branch: "b-lens",
          requiresArtifacts: ["scout_research", "brand_voice", "draft_set"],
          producesArtifacts: ["lens_review"],
        },
      ],
    });

    expect(launcher.launched[0]?.task).toContain("brand_voice");
    expect(launcher.launched[0]?.task).toContain("plain over hype");
    expect(launcher.launched[1]?.task).toContain("brand_voice");
    expect(launcher.launched[1]?.task).toContain("voiceConsistency");
  });

  it("does not mark a draft producer done until a valid draft_set is posted (#1541)", async () => {
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
          task: "draft channel-native assets",
          branch: "b-quill",
          producesArtifacts: ["draft_set"],
        },
      ],
    });

    expect(launcher.launched).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      subtaskId: "quill",
      ok: false,
      error: "blocked: missing produced artifact: Validated channel-native draft set",
    });
    expect(events().some((event) => event.kind === "done" && event.subtaskId === "quill")).toBe(false);
    expect(events().find((event) => event.kind === "blocked")?.summary).toBe(
      "blocked: missing produced artifact: Validated channel-native draft set",
    );
  });

  it("makes invalid draft_set validator failures visible in the timeline (#1541)", async () => {
    const launcher = new FakeLauncher();
    const { channel, postBody } = makeChannel();
    postBody(encodeTeamEvent({
      ...draftSetEvent,
      artifact: {
        kind: "draft_set",
        schemaVersion: 1,
        drafts: [
          {
            format: "email",
            title: "Bad email",
            fields: {
              subject: "This subject line is far too long for the email channel validator",
              preheader: "Short preheader",
              body: "Body",
              cta: "Review",
              plainTextAlt: "Body",
            },
            citations: ["SOC2 page mentions audit exports"],
          },
        ],
      },
    }));
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 1,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    const seen = await coordinator.readEvents("ch_1");

    expect(seen).toContainEqual(
      expect.objectContaining({
        kind: "blocked",
        summary: "blocked: invalid draft_set artifact: email.subject: must be 45 characters or fewer",
      }),
    );
  });

  it("blocks Lens before launch when the validated draft set is missing (#1541)", async () => {
    const launcher = new FakeLauncher();
    const { channel, events } = makeChannel();
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: scoutResearchEvent });
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
          subtaskId: "lens",
          agentMemberId: "mem_lens",
          task: "review drafts",
          branch: "b-lens",
          requiresArtifacts: ["scout_research", "draft_set"],
        },
      ],
    });

    expect(launcher.launched).toHaveLength(0);
    expect(result.results[0]).toMatchObject({
      subtaskId: "lens",
      ok: false,
      error: "blocked: missing required artifact: Validated channel-native draft set",
    });
    expect(events().find((event) => event.kind === "blocked")?.summary).toBe(
      "blocked: missing required artifact: Validated channel-native draft set",
    );
  });

  it("injects validated draft sets into Lens review tasks (#1541)", async () => {
    const launcher = new FakeLauncher();
    const { channel } = makeChannel();
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: scoutResearchEvent });
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: draftSetEvent });
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
          subtaskId: "lens",
          agentMemberId: "mem_lens",
          task: "review drafts",
          branch: "b-lens",
          requiresArtifacts: ["scout_research", "draft_set"],
        },
      ],
    });

    expect(launcher.launched[0]?.task).toContain("Launch email");
    expect(launcher.launched[0]?.task).toContain("Audit trails without chaos");
    expect(launcher.launched[0]?.task).toContain("review drafts");
  });

  it("adds content-quality rubric instructions to Lens producer tasks (#1542)", async () => {
    const launcher = new FakeLauncher();
    const { channel } = makeChannel();
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: scoutResearchEvent });
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: draftSetEvent });
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
          subtaskId: "lens",
          agentMemberId: "mem_lens",
          task: "score drafts",
          branch: "b-lens",
          requiresArtifacts: ["scout_research", "draft_set"],
          producesArtifacts: ["lens_review"],
        },
      ],
    });

    expect(launcher.launched[0]?.task).toContain("lens_review");
    expect(launcher.launched[0]?.task).toContain("specificityToBusiness");
    expect(launcher.launched[0]?.task).toContain('"threshold": 4');
    expect(launcher.launched[0]?.task).toContain("revisedDraft");
    expect(launcher.launched[0]?.task).toContain("score drafts");
  });

  it("does not mark Lens done until a valid lens_review is posted (#1542)", async () => {
    const launcher = new FakeLauncher();
    const { channel, events } = makeChannel();
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: scoutResearchEvent });
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: draftSetEvent });
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
          subtaskId: "lens",
          agentMemberId: "mem_lens",
          task: "score drafts",
          branch: "b-lens",
          requiresArtifacts: ["scout_research", "draft_set"],
          producesArtifacts: ["lens_review"],
        },
      ],
    });

    expect(launcher.launched).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      subtaskId: "lens",
      ok: false,
      error: "blocked: missing produced artifact: Lens rubric review",
    });
    expect(events().some((event) => event.kind === "done" && event.subtaskId === "lens")).toBe(false);
    expect(events().find((event) => event.kind === "blocked")?.summary).toBe(
      "blocked: missing produced artifact: Lens rubric review",
    );
  });

  it("makes invalid lens_review validator failures visible in the timeline (#1542)", async () => {
    const launcher = new FakeLauncher();
    const { channel, postBody } = makeChannel();
    postBody(encodeTeamEvent({
      ...lensReviewEvent,
      artifact: {
        kind: "lens_review",
        schemaVersion: 1,
        threshold: 4,
        summary: "The email needs revision before owner review.",
        reviews: [
          {
            format: "email",
            title: "Launch email",
            scores: {
              specificityToBusiness: 3,
              hookStrength: 3,
              clarity: 3,
              evidenceUse: 3,
              ctaQuality: 3,
              voiceConsistency: 3,
            },
            averageScore: 3,
            revisionNote: "Replace generic language with observed site proof.",
          },
        ],
      },
    }));
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 1,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    const seen = await coordinator.readEvents("ch_1");

    expect(seen).toContainEqual(
      expect.objectContaining({
        kind: "blocked",
        summary: "blocked: invalid lens_review artifact: email.revisedDraft: required when averageScore is below threshold",
      }),
    );
  });

  it("blocks distribution before launch when Lens scores are missing (#1542)", async () => {
    const launcher = new FakeLauncher();
    const { channel, events } = makeChannel();
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: scoutResearchEvent });
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: draftSetEvent });
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
          subtaskId: "echo",
          agentMemberId: "mem_echo",
          task: "plan distribution",
          branch: "b-echo",
          requiresArtifacts: ["scout_research", "draft_set", "lens_review"],
        },
      ],
    });

    expect(launcher.launched).toHaveLength(0);
    expect(result.results[0]).toMatchObject({
      subtaskId: "echo",
      ok: false,
      error: "blocked: missing required artifact: Lens rubric review",
    });
    expect(events().find((event) => event.kind === "blocked")?.summary).toBe(
      "blocked: missing required artifact: Lens rubric review",
    );
  });

  it("injects Lens scores into distribution tasks (#1542)", async () => {
    const launcher = new FakeLauncher();
    const { channel } = makeChannel();
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: scoutResearchEvent });
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: draftSetEvent });
    await channel.postEvent({ workspaceId: "ws_1", channelId: "ch_1", event: lensReviewEvent });
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
          subtaskId: "echo",
          agentMemberId: "mem_echo",
          task: "plan distribution",
          branch: "b-echo",
          requiresArtifacts: ["scout_research", "draft_set", "lens_review"],
        },
      ],
    });

    expect(launcher.launched[0]?.task).toContain("lens_review");
    expect(launcher.launched[0]?.task).toContain("averageScore");
    expect(launcher.launched[0]?.task).toContain("plan distribution");
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

  it("retries a failed subtask once when the route opts it into two attempts (#1545)", async () => {
    const launched: LaunchInput[] = [];
    const launcher: TeamLauncher = {
      async launch(input) {
        launched.push(input);
        return { id: "s" + launched.length };
      },
      async join(id) {
        if (id === "s1") throw new Error("transient runner failure");
      },
    };
    const { channel, events } = makeChannel();
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 1,
      logger: silentLogger,
      now: () => new Date(Date.UTC(2026, 5, 8, 0, 0, events().length)).toISOString(),
    });

    const result = await coordinator.runTeam({
      ...runInput(1),
      subtasks: [{ ...subtasks(1)[0]!, maxAttempts: 2 }],
    });
    const timeline = await coordinator.timeline("ch_1", "run_1");

    expect(launched).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ ok: true, attempts: 2, sessionId: "s2" });
    expect(events().some((event) => event.kind === "milestone" && event.summary.includes("retrying"))).toBe(true);
    expect(timeline.subtasks[0]).toMatchObject({
      subtaskId: "sub_0",
      state: "done",
      attempts: 2,
      sessionIds: ["s1", "s2"],
    });
  });

  it("cancels and blocks a timed-out subtask with an owner-readable reason (#1545)", async () => {
    const canceled: string[] = [];
    const launcher: TeamLauncher = {
      async launch() {
        return { id: "stuck" };
      },
      async join() {
        await new Promise(() => {});
      },
      async cancel(id) {
        canceled.push(id);
        return true;
      },
    };
    const { channel } = makeChannel();
    const coordinator = new TeamCoordinator({
      launcher,
      channel,
      maxConcurrency: 1,
      logger: silentLogger,
      now: () => "2026-06-08T00:00:00.000Z",
    });

    const result = await coordinator.runTeam({
      ...runInput(1),
      subtasks: [{ ...subtasks(1)[0]!, timeoutMs: 5, maxAttempts: 1 }],
    });
    const timeline = await coordinator.timeline("ch_1", "run_1");

    expect(canceled).toEqual(["stuck"]);
    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.error).toMatch(/^timed out after [1-5]ms$/);
    expect(timeline.subtasks[0]).toMatchObject({
      state: "failed",
      reason: result.results[0]?.error,
      sessionIds: ["stuck"],
    });
  });

  it("reconstructs a run timeline with queued inputs, artifacts, duration, and dead-run alerts (#1545)", async () => {
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
          subtaskId: "quill",
          agentMemberId: "mem_quill",
          task: "draft channel-native assets",
          branch: "b-quill",
          producesArtifacts: ["draft_set"],
        },
      ],
    });

    const timeline = await coordinator.timeline("ch_1", "run_1", {
      nowMs: Date.parse("2026-06-08T02:00:00.000Z"),
      stuckAfterMs: 60 * 60 * 1000,
    });

    expect(timeline.state).toBe("failed");
    expect(timeline.counts.failed).toBe(1);
    expect(timeline.subtasks[0]).toMatchObject({
      subtaskId: "quill",
      state: "failed",
      input: {
        task: "draft channel-native assets",
        producesArtifacts: ["draft_set"],
      },
      attempts: 1,
    });
    expect(timeline.alerts).toEqual([
      expect.objectContaining({
        kind: "dead_run",
        subtaskId: "quill",
        pageOwner: true,
      }),
    ]);
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
    expect(seen.map((e) => e.kind)).toEqual(["queued", "started", "done"]);
  });
});
