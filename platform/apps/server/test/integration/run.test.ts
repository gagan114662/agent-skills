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
import { RunProcessManager } from "../../src/run/manager.js";
import { CONFIG_DEFAULTS, type RunConfig } from "../../src/config/schema.js";
import type { ResourceCaps } from "../../src/db/repositories/agent-sessions.js";
import type { ServerEvent } from "../../src/realtime/protocol.js";

/** A no-op logger so the managers' internal logging doesn't spam the test output. */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CAPS: ResourceCaps = { wallClockMs: 20_000, idleMs: 8_000 };

// The SessionManager's harness: prints the task and exits 0 (the follow-up annotation session lands).
const COMPLETING_HARNESS = [
  "-e",
  "console.log('agent: task=' + (process.env.AGENT_TASK || 'none'));",
];

// The Run tab's run command: a tiny HTTP server that binds an ephemeral port and logs a detectable
// "listening on http://localhost:PORT" line, then stays up — exactly what a dev server looks like.
const RUN_SCRIPT =
  "const s=require('http').createServer((_,r)=>r.end('ok'));" +
  "s.listen(0,'127.0.0.1',()=>console.log('listening on http://localhost:'+s.address().port));";
const RUN_COMMAND = `"${process.execPath}" -e ${JSON.stringify(RUN_SCRIPT)}`;

const apps: FastifyInstance[] = [];
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

/** Build + listen an app whose RunProcessManager runs `runConfig` (undefined → no command → 409). */
async function startApp(runConfig?: RunConfig): Promise<{ app: FastifyInstance; ws: string }> {
  const sessionManager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: process.execPath, args: COMPLETING_HARNESS },
    caps: CAPS,
    logger: silentLogger,
  });
  const runManager = new RunProcessManager({
    provisioner: { prepare: () => Promise.resolve({ cwd: undefined }) },
    loadConfig: () => ({ ...CONFIG_DEFAULTS, run: runConfig }),
    logger: silentLogger,
  });
  const app = buildApp({ sessionManager, runManager });
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { app, ws: `ws://127.0.0.1:${port}/ws` };
}

interface World {
  cookie: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
}

/** Sign up a human in a fresh workspace, make a channel, register an agent. */
async function seed(app: FastifyInstance): Promise<World> {
  const slug = `run-${newId()}`;
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

/** Launch an agent session in the channel and return its id (the thing whose app we then run). */
async function launchSession(app: FastifyInstance, w: World): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/channels/${w.channelId}/agent-sessions`,
    cookies: { rid: w.cookie },
    payload: { agentMemberId: w.agentMemberId, task: "build the app" },
  });
  expect(res.statusCode).toBe(202);
  return res.json().id as string;
}

/** Poll a session's run state until a predicate holds or it times out. */
async function pollRun(
  app: FastifyInstance,
  w: World,
  sessionId: string,
  until: (s: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/agent-sessions/${sessionId}/run`,
        cookies: { rid: w.cookie },
      })
    ).json();
    if (until(body)) return body;
    if (Date.now() > deadline) throw new Error(`run stuck in ${String(body.status)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Open a subscribed socket that buffers events, awaiting `ready` then `subscribed` (no ready-race). */
async function subscribe(ws: string, w: World): Promise<{ events: ServerEvent[]; close: () => void }> {
  const socket = new WebSocket(ws, { headers: { cookie: `rid=${w.cookie}` } });
  const events: ServerEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
    socket.on("error", reject);
    socket.on("open", () => resolve());
  });
  await waitFor(events, (e) => e.type === "ready");
  socket.send(JSON.stringify({ type: "subscribe", channelId: w.channelId }));
  await waitFor(events, (e) => e.type === "subscribed");
  return { events, close: () => socket.terminate() };
}

/** Resolve once the buffer contains an event matching `match` (or reject after a timeout). */
function waitFor(
  events: ServerEvent[],
  match: (e: ServerEvent) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (events.some(match)) return resolve();
      if (Date.now() > deadline) return reject(new Error("timeout waiting for event"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("Run tab — run process + preview + annotations (real Postgres + Redis, LocalRuntime)", () => {
  it("runs a session's app, detects the localhost preview url, and broadcasts run events", async () => {
    const { app, ws } = await startApp({ command: RUN_COMMAND });
    const w = await seed(app);
    const sessionId = await launchSession(app, w);
    const sub = await subscribe(ws, w);

    const start = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/run`,
      cookies: { rid: w.cookie },
    });
    expect(start.statusCode).toBe(202);
    expect(start.json().status).toBe("starting");

    // GET is the source of truth: poll until the port is detected and the preview url appears.
    const running = await pollRun(app, w, sessionId, (s) => s.status === "running");
    expect(running.url).toMatch(/^http:\/\/localhost:\d+$/);

    // The status change is broadcast on the channel bus (the web Run tab consumes this live).
    await waitFor(sub.events, (e) => e.type === "run_status" && e.status === "running");
    expect(sub.events.some((e) => e.type === "run_log")).toBe(true);

    // Stopping kills the process and flips the run to `stopped`.
    const stop = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/run/stop`,
      cookies: { rid: w.cookie },
    });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().stopped).toBe(true);
    const stopped = await pollRun(app, w, sessionId, (s) => s.status === "stopped");
    expect(stopped.status).toBe("stopped");

    sub.close();
  });

  it("delivers preview annotations to the agent as a follow-up session (the round trip)", async () => {
    const { app } = await startApp({ command: RUN_COMMAND });
    const w = await seed(app);
    const sessionId = await launchSession(app, w);

    const before = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/agent-sessions`,
        cookies: { rid: w.cookie },
      })
    ).json() as unknown[];

    const res = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/annotations`,
      cookies: { rid: w.cookie },
      payload: {
        annotations: [
          { x: 0.34, y: 0.12, note: "the Save button is misaligned", pageUrl: "http://localhost:5173" },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().count).toBe(1);
    const followUpId = res.json().sessionId as string;
    expect(followUpId).toBeTruthy();
    expect(followUpId).not.toBe(sessionId);

    // A new agent session was launched into the same channel as the round trip.
    const after = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/agent-sessions`,
        cookies: { rid: w.cookie },
      })
    ).json() as unknown[];
    expect(after.length).toBe(before.length + 1);
  });

  it("returns 409 when the session has no run command configured", async () => {
    const { app } = await startApp(); // no run config
    const w = await seed(app);
    const sessionId = await launchSession(app, w);

    const res = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/run`,
      cookies: { rid: w.cookie },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects malformed annotations with 400", async () => {
    const { app } = await startApp({ command: RUN_COMMAND });
    const w = await seed(app);
    const sessionId = await launchSession(app, w);

    const res = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/annotations`,
      cookies: { rid: w.cookie },
      payload: { annotations: [{ x: 2, y: 0.1, note: "out of range" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("cannot run a session across a channel/workspace boundary (IDOR)", async () => {
    const { app } = await startApp({ command: RUN_COMMAND });
    const a = await seed(app);
    const b = await seed(app); // different workspace + cookie
    const sessionId = await launchSession(app, a);

    const res = await app.inject({
      method: "POST",
      url: `/channels/${a.channelId}/agent-sessions/${sessionId}/run`, // A's channel + session
      cookies: { rid: b.cookie }, // B's identity
    });
    expect(res.statusCode).toBe(404); // A's channel is invisible to B
  });
});
