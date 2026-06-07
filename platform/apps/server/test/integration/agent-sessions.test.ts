import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { LocalRuntime } from "../../src/runtime/local.js";
import { SessionManager, type SessionLogger } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { dbStore, channelPoster } from "../../src/runtime/default.js";
import type { ResourceCaps } from "../../src/db/repositories/agent-sessions.js";

/** A no-op logger so the manager's internal logging doesn't spam the test output. */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const SECRET = "sk-supersecret-value-do-not-leak-123";

// A real (host) harness via node -e: prints the task + a secret line + done, then exits 0.
const COMPLETING_HARNESS = [
  "-e",
  "console.log('agent: task=' + (process.env.AGENT_TASK || 'none'));" +
    "console.log('agent: secret=' + (process.env.MY_SECRET || 'none'));" +
    "setTimeout(() => console.log('agent: done — kept working after the client left'), 50);",
];

// A harness that produces NO output and never exits on its own — to exercise the idle reaper.
const SILENT_HARNESS = ["-e", "setTimeout(() => {}, 60000)"];

const apps: FastifyInstance[] = [];
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

/** Build + listen an app whose SessionManager uses LocalRuntime with the given harness/caps. */
async function startApp(harnessArgs: string[], caps: ResourceCaps): Promise<{
  app: FastifyInstance;
  http: string;
  ws: string;
}> {
  const manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({ MY_SECRET: SECRET }),
    harness: { command: process.execPath, args: harnessArgs }, // process.execPath = node
    caps,
    logger: silentLogger,
  });
  const app = buildApp({ sessionManager: manager });
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { app, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws` };
}

interface World {
  cookie: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
}

/** Sign up a human in a fresh workspace, make a channel, register an agent. */
async function seed(app: FastifyInstance): Promise<World> {
  const slug = `as-${newId()}`;
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
    payload: { name: "agents" },
  });
  const agent = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/agents`,
    cookies: { rid: cookie },
    payload: { name: "Scout" },
  });
  return {
    cookie,
    workspaceId: me.workspaceId,
    channelId: channel.json().id,
    agentMemberId: agent.json().memberId,
  };
}

/** Poll a session's status until it reaches a terminal state or times out. */
async function pollStatus(
  app: FastifyInstance,
  w: World,
  sessionId: string,
  until: (s: string) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({
      method: "GET",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}`,
      cookies: { rid: w.cookie },
    });
    const body = res.json();
    if (until(body.status)) return body;
    if (Date.now() > deadline) throw new Error(`session stuck in ${body.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("cloud agent execution (real Postgres + Redis, LocalRuntime, no cloud)", () => {
  it("runs server-side with the client disconnected and lands the result in the channel", async () => {
    const { app, ws } = await startApp(COMPLETING_HARNESS, { wallClockMs: 20_000, idleMs: 8_000 });
    const w = await seed(app);

    // The launching client connects, subscribes, then DROPS the connection ("closes the laptop").
    const socket = new WebSocket(ws, { headers: { cookie: `rid=${w.cookie}` } });
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", reject);
    });
    socket.send(JSON.stringify({ type: "subscribe", channelId: w.channelId }));

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "summarize the repo" },
    });
    expect(launch.statusCode).toBe(202);
    const sessionId = launch.json().id as string;

    // Laptop closed: kill the client connection while the agent is still working.
    socket.terminate();

    // The server keeps going. Poll until it finishes.
    const session = await pollStatus(app, w, sessionId, (s) => s === "completed" || s === "failed");
    expect(session.status).toBe("completed");
    expect(session.result).toContain("summarize the repo");

    // The streamed output + result are persisted in the channel even though no client was attached.
    const messages = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/messages`,
        cookies: { rid: w.cookie },
      })
    ).json() as { body: string }[];
    const bodies = messages.map((m) => m.body);
    expect(bodies.some((b) => b.includes("session") && b.includes("started"))).toBe(true);
    expect(bodies.some((b) => b.includes("agent: task=summarize the repo"))).toBe(true);
    expect(bodies.some((b) => b.includes("kept working after the client left"))).toBe(true);
    expect(bodies.some((b) => b.includes("session completed"))).toBe(true);

    // Secret injected at provision is NEVER persisted — redacted in every message + the result.
    const all = bodies.join("\n") + String(session.result);
    expect(all).not.toContain(SECRET);
    expect(bodies.some((b) => b.includes("agent: secret=‹redacted›"))).toBe(true);
  });

  it("reaps an idle session to idle_reaped and enforces the cap", async () => {
    const { app } = await startApp(SILENT_HARNESS, { wallClockMs: 30_000, idleMs: 400 });
    const w = await seed(app);

    const launch = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions`,
      cookies: { rid: w.cookie },
      payload: { agentMemberId: w.agentMemberId, task: "sleep forever" },
    });
    expect(launch.statusCode).toBe(202);

    const session = await pollStatus(app, w, launch.json().id, (s) => s === "idle_reaped");
    expect(session.status).toBe("idle_reaped");
    expect(session.endedAt).toBeTruthy();
  });

  it("a workspace cannot launch a session into another workspace's channel (IDOR)", async () => {
    const { app } = await startApp(COMPLETING_HARNESS, { wallClockMs: 20_000, idleMs: 8_000 });
    const a = await seed(app);
    const b = await seed(app); // different workspace + cookie

    const res = await app.inject({
      method: "POST",
      url: `/channels/${a.channelId}/agent-sessions`, // A's channel
      cookies: { rid: b.cookie }, // B's identity
      payload: { agentMemberId: b.agentMemberId, task: "intrude" },
    });
    expect(res.statusCode).toBe(404); // cross-workspace channel is invisible
  });
});
