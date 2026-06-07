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

async function newHuman(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `tm-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Lead", workspaceSlug: slug },
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
  name: string,
): Promise<{ token: string; memberId: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/agents`,
    cookies: { rid: cookie },
    payload: { name },
  });
  return { token: res.json().token as string, memberId: res.json().memberId as string };
}

async function postRoot(cookie: string, channelId: string, body: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/channels/${channelId}/messages`,
    cookies: { rid: cookie },
    payload: { body },
  });
  return res.json().id as string;
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

describe("threads + @mentions (real Postgres + Redis)", () => {
  it("a reply creates a thread, broadcasts over WS, and is returned in order with a count", async () => {
    const h = await newHuman();
    const cid = await createChannel(h.cookie, h.workspaceId, "general");
    const rootId = await postRoot(h.cookie, cid, "let's discuss the rollout");

    // subscribe over WS, then post a reply via the reply endpoint → expect a live message event
    const client = await open({ headers: { cookie: `rid=${h.cookie}` } });
    await client.waitFor((e) => e.type === "ready");
    client.send({ type: "subscribe", channelId: cid });
    await client.waitFor((e) => e.type === "subscribed" && e.channelId === cid);

    const reply1 = await app.inject({
      method: "POST",
      url: `/channels/${cid}/messages/${rootId}/replies`,
      cookies: { rid: h.cookie },
      payload: { body: "first reply" },
    });
    expect(reply1.statusCode).toBe(201);
    expect(reply1.json().parentMessageId).toBe(rootId);

    const evt = await client.waitFor((e) => e.type === "message" && "message" in e && e.message.body === "first reply");
    expect(evt).toMatchObject({ type: "message", message: { parentMessageId: rootId, body: "first reply" } });

    // a second reply, then assert thread ordering + count
    await app.inject({
      method: "POST",
      url: `/channels/${cid}/messages/${rootId}/replies`,
      cookies: { rid: h.cookie },
      payload: { body: "second reply" },
    });

    const thread = await app.inject({
      method: "GET",
      url: `/channels/${cid}/messages/${rootId}/thread`,
      cookies: { rid: h.cookie },
    });
    expect(thread.statusCode).toBe(200);
    const body = thread.json();
    expect(body.root.id).toBe(rootId);
    expect(body.replyCount).toBe(2);
    expect(body.replies.map((m: { body: string }) => m.body)).toEqual(["first reply", "second reply"]);

    // a reply to a reply re-parents to the root (threads stay one level deep)
    const firstReplyId = body.replies[0].id as string;
    const nested = await app.inject({
      method: "POST",
      url: `/channels/${cid}/messages/${firstReplyId}/replies`,
      cookies: { rid: h.cookie },
      payload: { body: "nested" },
    });
    expect(nested.json().parentMessageId).toBe(rootId);
    client.close();
  });

  it("@mention persists a record and notifies the mentioned agent over WS; self/unknown create none", async () => {
    const h = await newHuman();
    const cid = await createChannel(h.cookie, h.workspaceId, "ops");
    const agent = await registerAgent(h.cookie, h.workspaceId, "Scout");

    // the agent connects but does NOT subscribe — a mention reaches it regardless of subscription
    const agentClient = await open({ headers: { authorization: `Bearer ${agent.token}` } });
    await agentClient.waitFor((e) => e.type === "ready");

    const posted = await app.inject({
      method: "POST",
      url: `/channels/${cid}/messages`,
      cookies: { rid: h.cookie },
      payload: { body: "hey @Scout can you take this? cc @ghost and myself @Lead" },
    });
    const messageId = posted.json().id as string;

    // the agent receives an actionable mention event
    const mentionEvt = await agentClient.waitFor((e) => e.type === "mention");
    expect(mentionEvt).toMatchObject({
      type: "mention",
      mention: { messageId, channelId: cid, mentionedMemberId: agent.memberId, authorMemberId: h.memberId },
    });

    // "my mentions" + count for the agent surface exactly one (not self, not the unknown @ghost)
    const mine = await app.inject({
      method: "GET",
      url: "/me/mentions",
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toHaveLength(1);
    expect(mine.json()[0]).toMatchObject({ messageId, channelId: cid });

    const count = await app.inject({
      method: "GET",
      url: "/me/mentions/count",
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(count.json().count).toBe(1);

    // the author @Lead mentioned themselves → no self-mention surfaced to the author
    const authorMentions = await app.inject({
      method: "GET",
      url: "/me/mentions",
      cookies: { rid: h.cookie },
    });
    expect(authorMentions.json()).toHaveLength(0);
    agentClient.close();
  });

  it("blocks a non-member and a read-only member from replying, and a non-member from reading a thread", async () => {
    const h = await newHuman();
    const cid = await createChannel(h.cookie, h.workspaceId, "secure");
    const rootId = await postRoot(h.cookie, cid, "members only");

    // an agent in the workspace but NOT in the channel
    const outsider = await registerAgent(h.cookie, h.workspaceId, "Outsider");
    const replyAsOutsider = await app.inject({
      method: "POST",
      url: `/channels/${cid}/messages/${rootId}/replies`,
      headers: { authorization: `Bearer ${outsider.token}` },
      payload: { body: "let me in" },
    });
    expect(replyAsOutsider.statusCode).toBe(403);

    // and a non-member cannot read the thread
    const readThread = await app.inject({
      method: "GET",
      url: `/channels/${cid}/messages/${rootId}/thread`,
      headers: { authorization: `Bearer ${outsider.token}` },
    });
    expect(readThread.statusCode).toBe(403);

    // a read-only member (explicit downgrade grant) can view but not reply
    const reader = await registerAgent(h.cookie, h.workspaceId, "Reader");
    await app.inject({
      method: "POST",
      url: `/channels/${cid}/grants`,
      cookies: { rid: h.cookie },
      payload: { memberId: reader.memberId, capability: "read" },
    });
    const readerThread = await app.inject({
      method: "GET",
      url: `/channels/${cid}/messages/${rootId}/thread`,
      headers: { authorization: `Bearer ${reader.token}` },
    });
    expect(readerThread.statusCode).toBe(200);
    const readerReply = await app.inject({
      method: "POST",
      url: `/channels/${cid}/messages/${rootId}/replies`,
      headers: { authorization: `Bearer ${reader.token}` },
      payload: { body: "may I?" },
    });
    expect(readerReply.statusCode).toBe(403);
  });
});
