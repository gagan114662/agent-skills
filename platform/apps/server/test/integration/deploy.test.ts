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
import { DeployManager } from "../../src/deploy/manager.js";
import { DryRunDeployProvider } from "../../src/deploy/dry-run-provider.js";
import { dbDeploymentStore } from "../../src/db/repositories/deployments.js";
import { channelPoster } from "../../src/runtime/default.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { CONFIG_DEFAULTS, type DeployConfig } from "../../src/config/schema.js";
import type { SessionLogger } from "../../src/runtime/manager.js";
import type { ServerEvent } from "../../src/realtime/protocol.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const SECRET = "sk-deploy-secret-xyz";

const apps: FastifyInstance[] = [];
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const app of apps) await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

/** Build + listen an app whose DeployManager uses the no-spend dry-run provider over real Postgres. */
async function startApp(opts: { deploy?: DeployConfig; dataPrivacyMode?: boolean } = {}): Promise<{
  app: FastifyInstance;
  ws: string;
}> {
  const deployManager = new DeployManager({
    provider: new DryRunDeployProvider(),
    store: dbDeploymentStore,
    poster: channelPoster,
    provisioner: { prepare: () => Promise.resolve({ cwd: undefined }) },
    secrets: new StaticSecretsResolver({ DEPLOY_SECRET: SECRET }),
    loadConfig: () => ({
      ...CONFIG_DEFAULTS,
      dataPrivacyMode: opts.dataPrivacyMode ?? false,
      deploy: opts.deploy,
    }),
    logger: silentLogger,
  });
  const app = buildApp({ deployManager });
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

async function seed(app: FastifyInstance): Promise<World> {
  const slug = `deploy-${newId()}`;
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

function waitFor(events: ServerEvent[], match: (e: ServerEvent) => boolean, timeoutMs = 5000): Promise<void> {
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

const DEPLOY_CFG: DeployConfig = { provider: "dryrun", maxInstances: 3 };

describe("Deploy to live URL (#73 — real Postgres + Redis, dry-run provider)", () => {
  it("deploys a session's app to a live https URL, posts it to the channel, and broadcasts events", async () => {
    const { app, ws } = await startApp({ deploy: DEPLOY_CFG });
    const w = await seed(app);
    const sessionId = await launchSession(app, w);
    const sub = await subscribe(ws, w);

    const res = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/deploy`,
      cookies: { rid: w.cookie },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("ready");
    expect(res.json().url).toMatch(/^https:\/\/.+/);
    const url = res.json().url as string;

    // The live URL was posted into the channel as a message (persisted, source of truth).
    await waitFor(sub.events, (e) => e.type === "message" && e.message.body.includes(url));
    // The status change is broadcast on the channel bus (the web Deploy tab consumes this live).
    await waitFor(sub.events, (e) => e.type === "deploy_status" && e.status === "ready");
    expect(sub.events.some((e) => e.type === "deploy_log")).toBe(true);

    // A secret never appears in any streamed log event nor the persisted log tail.
    for (const e of sub.events) if (e.type === "deploy_log") expect(e.chunk).not.toContain(SECRET);
    const state = await app.inject({
      method: "GET",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/deploy`,
      cookies: { rid: w.cookie },
    });
    expect(state.statusCode).toBe(200);
    expect((state.json().logs as string[]).join("\n")).not.toContain(SECRET);

    sub.close();
  });

  it("redeploys (a new immutable deployment) and rolls back to a prior good one", async () => {
    const { app } = await startApp({ deploy: DEPLOY_CFG });
    const w = await seed(app);
    const sessionId = await launchSession(app, w);

    const first = (
      await app.inject({
        method: "POST",
        url: `/channels/${w.channelId}/agent-sessions/${sessionId}/deploy`,
        cookies: { rid: w.cookie },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/deploy`,
      cookies: { rid: w.cookie },
      payload: { reason: "push" },
    });

    const history = (
      await app.inject({
        method: "GET",
        url: `/channels/${w.channelId}/agent-sessions/${sessionId}/deploy/history`,
        cookies: { rid: w.cookie },
      })
    ).json() as { id: string }[];
    expect(history.length).toBe(2);

    const rolled = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/deploy/rollback`,
      cookies: { rid: w.cookie },
    });
    expect(rolled.statusCode).toBe(202);
    expect(rolled.json().status).toBe("rolled_back");
    expect(rolled.json().rolledBackFromId).toBe(first.id);
  });

  it("returns 409 when the session's tenant has not enabled deploy", async () => {
    const { app } = await startApp({}); // no deploy config
    const w = await seed(app);
    const sessionId = await launchSession(app, w);
    const res = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/deploy`,
      cookies: { rid: w.cookie },
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 409 when data-privacy mode forbids off-platform egress", async () => {
    const { app } = await startApp({ deploy: DEPLOY_CFG, dataPrivacyMode: true });
    const w = await seed(app);
    const sessionId = await launchSession(app, w);
    const res = await app.inject({
      method: "POST",
      url: `/channels/${w.channelId}/agent-sessions/${sessionId}/deploy`,
      cookies: { rid: w.cookie },
    });
    expect(res.statusCode).toBe(409);
  });

  it("cannot deploy a session across a channel/workspace boundary (IDOR)", async () => {
    const { app } = await startApp({ deploy: DEPLOY_CFG });
    const a = await seed(app);
    const b = await seed(app);
    const sessionId = await launchSession(app, a);
    const res = await app.inject({
      method: "POST",
      url: `/channels/${a.channelId}/agent-sessions/${sessionId}/deploy`, // A's channel + session
      cookies: { rid: b.cookie }, // B's identity
    });
    expect(res.statusCode).toBe(404); // A's channel is invisible to B
  });
});
