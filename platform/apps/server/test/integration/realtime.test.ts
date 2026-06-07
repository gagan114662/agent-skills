import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { WebSocket, type ClientOptions } from "ws";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import type { ClientCommand, ServerEvent } from "../../src/realtime/protocol.js";

let app: FastifyInstance;
let wsBase: string;
const slugs: string[] = [];

beforeAll(async () => {
  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  wsBase = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

/** Sign up a fresh human in a fresh workspace; return cookie, workspaceId, memberId. */
async function newHuman(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `rt-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

async function createChannel(cookie: string, workspaceId: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/channels`,
    cookies: { rid: cookie },
    payload: { name },
  });
  return res.json().id as string;
}

async function registerAgent(
  cookie: string,
  workspaceId: string,
): Promise<{ token: string; memberId: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/agents`,
    cookies: { rid: cookie },
    payload: { name: "Scout" },
  });
  return { token: res.json().token as string, memberId: res.json().memberId as string };
}

async function postMessage(cookie: string, channelId: string, body: string): Promise<void> {
  await app.inject({
    method: "POST",
    url: `/channels/${channelId}/messages`,
    cookies: { rid: cookie },
    payload: { body },
  });
}

/** Buffers server events and lets a test await the next one matching a predicate. */
class TestClient {
  readonly ws: WebSocket;
  private readonly events: ServerEvent[] = [];
  private waiters: { match: (e: ServerEvent) => boolean; resolve: (e: ServerEvent) => void }[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const evt = JSON.parse(data.toString()) as ServerEvent;
      this.events.push(evt);
      this.waiters = this.waiters.filter((w) => {
        if (w.match(evt)) {
          w.resolve(evt);
          return false;
        }
        return true;
      });
    });
  }

  send(cmd: ClientCommand): void {
    this.ws.send(JSON.stringify(cmd));
  }

  waitFor(match: (e: ServerEvent) => boolean, timeoutMs = 5000): Promise<ServerEvent> {
    const found = this.events.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for event")), timeoutMs);
      this.waiters.push({ match, resolve: (e) => (clearTimeout(timer), resolve(e)) });
    });
  }

  async assertNo(match: (e: ServerEvent) => boolean, windowMs = 700): Promise<void> {
    await new Promise((r) => setTimeout(r, windowMs));
    expect(this.events.find(match)).toBeUndefined();
  }

  close(): void {
    this.ws.close();
  }
}

function open(opts?: ClientOptions): Promise<TestClient> {
  const ws = new WebSocket(wsBase, opts);
  const client = new TestClient(ws);
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(client));
    ws.on("error", reject);
    ws.on("unexpected-response", (_req, res) =>
      reject(new Error(`unexpected upgrade response ${res.statusCode}`)),
    );
  });
}

describe("realtime messaging over WebSocket (real Postgres + Redis)", () => {
  it("a channel member receives a message broadcast over WS", async () => {
    const h = await newHuman();
    const cid = await createChannel(h.cookie, h.workspaceId, "general");

    const client = await open({ headers: { cookie: `rid=${h.cookie}` } });
    await client.waitFor((e) => e.type === "ready");
    client.send({ type: "subscribe", channelId: cid });
    await client.waitFor((e) => e.type === "subscribed" && e.channelId === cid);

    await postMessage(h.cookie, cid, "live hello");

    const evt = await client.waitFor((e) => e.type === "message");
    expect(evt).toMatchObject({ type: "message", message: { channelId: cid, body: "live hello" } });
    client.close();
  });

  it("a non-member cannot subscribe (forbidden) and receives no broadcast", async () => {
    const h = await newHuman();
    const cid = await createChannel(h.cookie, h.workspaceId, "private-ish");
    const agent = await registerAgent(h.cookie, h.workspaceId); // workspace member, NOT channel member

    const outsider = await open({ headers: { authorization: `Bearer ${agent.token}` } });
    await outsider.waitFor((e) => e.type === "ready");
    outsider.send({ type: "subscribe", channelId: cid });

    const err = await outsider.waitFor((e) => e.type === "error");
    expect(err).toMatchObject({ type: "error", code: "forbidden" });

    // and it never receives a message posted to that channel
    await postMessage(h.cookie, cid, "secret");
    await outsider.assertNo((e) => e.type === "message");
    outsider.close();
  });

  it("presence online/away propagates to the workspace", async () => {
    const h = await newHuman();
    const agent = await registerAgent(h.cookie, h.workspaceId);

    const a = await open({ headers: { cookie: `rid=${h.cookie}` } });
    await a.waitFor((e) => e.type === "ready");

    // member B (the agent) connects → A sees B online
    const b = await open({ headers: { authorization: `Bearer ${agent.token}` } });
    await b.waitFor((e) => e.type === "ready");
    const online = await a.waitFor(
      (e) => e.type === "presence" && e.memberId === agent.memberId && e.status === "online",
    );
    expect(online).toMatchObject({ status: "online" });

    // B goes away → A sees away
    b.send({ type: "presence", status: "away" });
    const away = await a.waitFor(
      (e) => e.type === "presence" && e.memberId === agent.memberId && e.status === "away",
    );
    expect(away).toMatchObject({ status: "away" });

    a.close();
    b.close();
  });

  it("rejects an unauthenticated upgrade with 401", async () => {
    const ws = new WebSocket(wsBase);
    const status = await new Promise<number | "error">((resolve) => {
      ws.on("open", () => {
        ws.close();
        resolve(0 as unknown as number);
      });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? ("error" as const)));
      ws.on("error", () => resolve("error"));
    });
    expect(status).toBe(401);
  });
});
