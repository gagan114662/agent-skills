import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { LocalRuntime } from "../../src/runtime/local.js";
import { SessionManager, type SessionLogger } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { dbStore, channelPoster } from "../../src/runtime/default.js";
import { listChannelMessages } from "../../src/db/repositories/messages.js";
import { publishTeamEvent } from "../../src/realtime/bus.js";
import { TeamChannel } from "../../src/team/channel.js";
import { TeamCoordinator } from "../../src/team/coordinator.js";
import type { CodexSubscriptionStatusProvider } from "../../src/routes/team.js";
import type { TeamEvent } from "@reload/shared";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

// A real (host) harness via node -e: echoes the task then exits 0 after a short tick.
const COMPLETING_HARNESS = [
  "-e",
  "console.log('agent: ' + (process.env.AGENT_TASK || 'none'));" +
    "setTimeout(() => console.log('agent: done'), 20);",
];

const ARTIFACT_ROOM_HARNESS = [
  "-e",
  [
    "const task = process.env.AGENT_TASK || '';",
    "const pick = (name) => (task.match(new RegExp('\\\\\"' + name + '\\\\\": \\\\\"([^\\\\\"]+)\\\\\"')) || [])[1] || '';",
    "const teamRunId = pick('teamRunId');",
    "const subtaskId = pick('subtaskId');",
    "const agentMemberId = pick('agentMemberId');",
    "const branch = pick('branch');",
    "const emit = (event) => console.log('::team-event:: ' + JSON.stringify(event));",
    "if (task.includes('\\\"kind\\\": \\\"draft_set\\\"')) {",
    "  emit({",
    "    teamRunId, subtaskId, agentMemberId, kind: 'milestone', summary: 'draft set ready: getfoolish.com', branch, createdAt: '2026-07-02T00:00:01.000Z',",
    "    artifact: { kind: 'draft_set', schemaVersion: 1, drafts: [{",
    "      format: 'landing_hero',",
    "      title: 'Foolish first-click hero',",
    "      fields: { headline: 'Find the expensive leak before your next ad dollar', subhead: 'Get Foolish turns messy acquisition guesses into one focused next test.', cta: 'Find the leak' },",
    "      citations: ['The homepage promises to find acquisition leaks']",
    "    }] }",
    "  });",
    "} else if (task.includes('\\\"kind\\\": \\\"scout_research\\\"')) {",
    "  emit({",
    "    teamRunId, subtaskId, agentMemberId, kind: 'milestone', summary: 'research artifact ready: getfoolish.com', branch, createdAt: '2026-07-02T00:00:00.000Z',",
    "    artifact: {",
    "      kind: 'scout_research', schemaVersion: 1,",
    "      siteSummary: 'Get Foolish helps teams find the expensive leak before the next ad dollar.',",
    "      icp: 'Founders and growth leads with unclear acquisition performance',",
    "      positioning: 'Find the expensive leak before your next ad dollar.',",
    "      proofPoints: ['The homepage promises to find acquisition leaks', 'The product frames the next test as the useful action'],",
    "      competitors: ['spreadsheet audit', 'generic agency review'],",
    "      toneNotes: 'Plain, mischievous, evidence-first.',",
    "      sourceUrls: ['https://getfoolish.com']",
    "    }",
    "  });",
    "  setInterval(() => {}, 1000);",
    "}",
  ].join("\n"),
];

const apps: FastifyInstance[] = [];
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

/** Build + listen an app whose TeamCoordinator drives a LocalRuntime SessionManager. */
async function startApp(
  maxConcurrency: number,
  codexSubscription?: CodexSubscriptionStatusProvider,
  harnessArgs: string[] = COMPLETING_HARNESS,
): Promise<{ app: FastifyInstance; http: string }> {
  const manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: process.execPath, args: harnessArgs },
    harnessOverrides: () => ({
      command: process.execPath,
      args: harnessArgs,
      decode: (line) => ({ display: [line], raw: null }),
    }),
    caps: { wallClockMs: 20_000, idleMs: 8_000 },
    logger: silentLogger,
  });
  const channel = new TeamChannel({
    poster: channelPoster,
    publish: (cid, ev) => publishTeamEvent(cid, ev).catch(() => {}),
    listMessages: listChannelMessages,
  });
  const coordinator = new TeamCoordinator({
    launcher: manager,
    channel,
    maxConcurrency,
    logger: silentLogger,
  });
  const app = buildApp({ sessionManager: manager, teamCoordinator: coordinator, codexSubscription });
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { app, http: `http://127.0.0.1:${port}` };
}

interface World {
  cookie: string;
  workspaceId: string;
  channelId: string;
  agentMemberIds: string[];
}

/** Sign up a human, make a channel, and register N agents. */
async function seed(app: FastifyInstance, agentCount: number): Promise<World> {
  const slug = `tm-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  const channel = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/channels`,
    cookies: { rid: cookie },
    payload: { name: "feature-team" },
  });
  const agentMemberIds: string[] = [];
  for (let i = 0; i < agentCount; i++) {
    const agent = await app.inject({
      method: "POST",
      url: `/workspaces/${me.workspaceId}/agents`,
      cookies: { rid: cookie },
      payload: { name: `Builder-${i}` },
    });
    agentMemberIds.push(agent.json().memberId);
  }
  return { cookie, workspaceId: me.workspaceId, channelId: channel.json().id, agentMemberIds };
}

/** Poll the channel's agent sessions until `count` of them reach a terminal state. */
async function pollTerminal(
  app: FastifyInstance,
  w: World,
  count: number,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sessions = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/agent-sessions`,
        cookies: { rid: w.cookie },
      })
    ).json() as Record<string, unknown>[];
    const terminal = sessions.filter((s) => s.status === "completed" || s.status === "failed");
    if (terminal.length >= count) return terminal;
    if (Date.now() > deadline) {
      throw new Error(`only ${terminal.length}/${count} sessions terminal in time`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Poll the visible team channel receipts until every expected event has been persisted. */
async function pollTeamEvents(
  app: FastifyInstance,
  w: World,
  teamRunId: string,
  expected: { started: number; done: number },
  timeoutMs = 15_000,
): Promise<TeamEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/team-events`,
        cookies: { rid: w.cookie },
      })
    ).json() as TeamEvent[];
    const matching = events.filter((e) => e.teamRunId === teamRunId);
    const started = matching.filter((e) => e.kind === "started");
    const done = matching.filter((e) => e.kind === "done");
    if (started.length >= expected.started && done.length >= expected.done) return matching;
    if (Date.now() > deadline) {
      throw new Error(
        `only ${started.length}/${expected.started} started and ${done.length}/${expected.done} done team events visible in time`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("Team Mode (real Postgres + Redis, LocalRuntime, no cloud)", () => {
  it("creates a channel-scoped team run at the exact web client route", async () => {
    const { app } = await startApp(1);
    const w = await seed(app, 1);

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/team-runs`,
      cookies: { rid: w.cookie },
      payload: {
        subtasks: [
          {
            agentMemberId: w.agentMemberIds[0],
            task: "draft one useful launch asset",
            branch: "ipop-route-smoke",
          },
        ],
      },
    });

    expect(launch.statusCode).toBe(201);
    const body = launch.json();
    expect(typeof body.teamRunId).toBe("string");
    expect(body).toMatchObject({
      subtaskCount: 1,
      subtasks: [{ agentMemberId: w.agentMemberIds[0], branch: "ipop-route-smoke" }],
    });
  });

  it("runs 3 agents in parallel on one feature and coordinates over the team channel", async () => {
    const { app } = await startApp(3);
    const w = await seed(app, 3);

    const subtasks = w.agentMemberIds.map((agentMemberId, i) => ({
      agentMemberId,
      task: `implement part ${i}`,
      branch: `feat/part-${i}`,
    }));

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/team-runs`,
      cookies: { rid: w.cookie },
      payload: { subtasks },
    });
    expect(launch.statusCode).toBe(201);
    const body = launch.json();
    expect(body.subtaskCount).toBe(3);
    expect(typeof body.teamRunId).toBe("string");

    // All three sessions run server-side and finish.
    const terminal = await pollTerminal(app, w, 3);
    expect(terminal.filter((s) => s.status === "completed")).toHaveLength(3);

    // The shared team channel carries a started + done event for each of the 3 subtasks.
    const events = await pollTeamEvents(app, w, body.teamRunId, { started: 3, done: 3 });

    expect(events.every((e) => e.teamRunId === body.teamRunId)).toBe(true);
    const started = events.filter((e) => e.kind === "started");
    const done = events.filter((e) => e.kind === "done");
    expect(started).toHaveLength(3);
    expect(done).toHaveLength(3);
    // Each subtask owns a distinct branch — the basis for conflict-free merges.
    expect(new Set(done.map((e) => e.branch))).toEqual(
      new Set(["feat/part-0", "feat/part-1", "feat/part-2"]),
    );

    const timeline = await app.inject({
      method: "GET",
      url: `/channels/${w.channelId}/team-runs/${body.teamRunId}/timeline`,
      cookies: { rid: w.cookie },
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toMatchObject({
      teamRunId: body.teamRunId,
      state: "done",
      subtaskCount: 3,
      counts: { done: 3 },
    });
    expect(timeline.json().subtasks).toHaveLength(3);
    expect(timeline.json().subtasks[0]).toMatchObject({
      state: "done",
      attempts: 1,
      input: {
        maxAttempts: 2,
        timeoutMs: 30 * 60 * 1000,
      },
    });
    expect(typeof timeline.json().subtasks[0].durationMs).toBe("number");
  });

  it("drives Scout to done and Quill to a named draft artifact through the route (#1536)", async () => {
    const { app } = await startApp(1, undefined, ARTIFACT_ROOM_HARNESS);
    const w = await seed(app, 2);

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/team-runs`,
      cookies: { rid: w.cookie },
      payload: {
        subtasks: [
          {
            agentMemberId: w.agentMemberIds[0],
            task: "research getfoolish.com",
            branch: "ipop-scout-getfoolish",
            phase: 1,
            producesArtifacts: ["scout_research", "brand_voice"],
            timeoutMs: 5_000,
            maxAttempts: 1,
          },
          {
            agentMemberId: w.agentMemberIds[1],
            task: "draft first useful asset for getfoolish.com",
            branch: "ipop-quill-getfoolish",
            phase: 2,
            requiresArtifacts: ["scout_research", "brand_voice"],
            producesArtifacts: ["draft_set"],
            timeoutMs: 5_000,
            maxAttempts: 1,
          },
        ],
      },
    });
    expect(launch.statusCode).toBe(201);
    const body = launch.json();
    expect(typeof body.teamRunId).toBe("string");

    const events = await pollTeamEvents(app, w, body.teamRunId, { started: 2, done: 2 }, 15_000);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "milestone",
        artifact: expect.objectContaining({ kind: "brand_voice" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        subtaskId: body.subtasks[0].subtaskId,
        kind: "done",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        subtaskId: body.subtasks[1].subtaskId,
        kind: "milestone",
        artifact: expect.objectContaining({
          kind: "draft_set",
          drafts: [
            expect.objectContaining({
              title: "Foolish first-click hero",
              fields: expect.objectContaining({
                headline: "Find the expensive leak before your next ad dollar",
              }),
            }),
          ],
        }),
      }),
    );

    const timeline = await app.inject({
      method: "GET",
      url: `/channels/${w.channelId}/team-runs/${body.teamRunId}/timeline`,
      cookies: { rid: w.cookie },
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toMatchObject({
      state: "done",
      counts: { done: 2 },
    });
  });

  it("rejects a subtask whose agent is not an agent member of this workspace (IDOR)", async () => {
    const { app } = await startApp(2);
    const a = await seed(app, 1);
    const b = await seed(app, 1); // different workspace

    const res = await app.inject({
      method: "POST",
      url: `/channels/${a.channelId}/team-runs`, // A's channel
      cookies: { rid: b.cookie }, // B's identity
      payload: { subtasks: [{ agentMemberId: b.agentMemberIds[0], task: "intrude", branch: "x" }] },
    });
    expect(res.statusCode).toBe(404); // cross-workspace channel is invisible
  });

  it("validates an empty subtask list", async () => {
    const { app } = await startApp(2);
    const w = await seed(app, 1);
    const res = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/team-runs`,
      cookies: { rid: w.cookie },
      payload: { subtasks: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("fails closed when the room requests Codex without a connected subscription (#1282)", async () => {
    const disconnectedCodex: CodexSubscriptionStatusProvider = {
      async status() {
        return {
          connected: false,
          reason: "The team engine is not connected to this workspace's signed-in subscription yet.",
          selectedHarness: "codex",
          userAuthenticated: true,
          workspaceAuthenticated: true,
          runtimeAuth: "missing",
          fallback: "none",
          apiKeySatisfies: false,
        };
      },
    };
    const { app } = await startApp(2, disconnectedCodex);
    const w = await seed(app, 1);

    const status = await app.inject({
      method: "GET",
      url: "/me/codex/status",
      cookies: { rid: w.cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      connected: false,
      selectedHarness: "codex",
      userAuthenticated: true,
      workspaceAuthenticated: true,
      runtimeAuth: "missing",
      fallback: "none",
      apiKeySatisfies: false,
    });

    const preflight = await app.inject({
      method: "GET",
      url: "/me/codex/preflight",
      cookies: { rid: w.cookie },
    });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json()).toMatchObject({
      connected: false,
      selectedHarness: "codex",
      fallback: "none",
      apiKeySatisfies: false,
    });

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/team-runs`,
      cookies: { rid: w.cookie },
      payload: {
        subtasks: [
          {
            agentMemberId: w.agentMemberIds[0],
            task: "mine insights for ipop.ai",
            branch: "ipop-scout",
            harness: "codex",
          },
        ],
      },
    });

    expect(launch.statusCode).toBe(409);
    expect(launch.json()).toMatchObject({
      code: "codex_subscription_not_connected",
      status: {
        selectedHarness: "codex",
        runtimeAuth: "missing",
        fallback: "none",
        apiKeySatisfies: false,
      },
    });

    const sessions = await app.inject({
      method: "GET",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
    });
    expect(sessions.json()).toEqual([]);
  });

  it("starts a Codex-selected team run when the signed-in subscription preflight is connected (#1282)", async () => {
    const connectedCodex: CodexSubscriptionStatusProvider = {
      async status() {
        return {
          connected: true,
          reason: "OpenAI ChatGPT subscription auth is ready for Codex agent runs.",
          selectedHarness: "codex",
          userAuthenticated: true,
          workspaceAuthenticated: true,
          runtimeAuth: "signed_in_subscription",
          fallback: "none",
          apiKeySatisfies: false,
        };
      },
    };
    const { app } = await startApp(2, connectedCodex);
    const w = await seed(app, 1);

    const status = await app.inject({
      method: "GET",
      url: "/me/codex/status",
      cookies: { rid: w.cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      connected: true,
      selectedHarness: "codex",
      runtimeAuth: "signed_in_subscription",
      fallback: "none",
      apiKeySatisfies: false,
    });

    const launch = await app.inject({
      method: "POST",
      url: "/channels/" + w.channelId + "/team-runs",
      cookies: { rid: w.cookie },
      payload: {
        subtasks: [
          {
            agentMemberId: w.agentMemberIds[0],
            task: "mine insights for ipop.ai",
            branch: "ipop-scout",
            harness: "codex",
          },
        ],
      },
    });

    expect(launch.statusCode).toBe(201);
    expect(launch.json()).toMatchObject({
      subtaskCount: 1,
      subtasks: [{ agentMemberId: w.agentMemberIds[0], branch: "ipop-scout", harness: "codex" }],
    });
  });
});
