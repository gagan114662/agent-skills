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

interface Human {
  cookie: string;
  workspaceId: string;
  memberId: string;
}

async function newHuman(name = "Lead"): Promise<Human> {
  const slug = `nt-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: name, workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

async function registerAgent(
  h: Human,
  name: string,
): Promise<{ token: string; memberId: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${h.workspaceId}/agents`,
    cookies: { rid: h.cookie },
    payload: { name },
  });
  return { token: res.json().token as string, memberId: res.json().memberId as string };
}

async function createChannel(h: Human, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${h.workspaceId}/channels`,
    cookies: { rid: h.cookie },
    payload: { name },
  });
  return res.json().id as string;
}

async function createDm(h: Human, otherMemberId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${h.workspaceId}/dms`,
    cookies: { rid: h.cookie },
    payload: { memberIds: [otherMemberId] },
  });
  return res.json().id as string;
}

async function post(h: Human, channelId: string, body: string): Promise<void> {
  await app.inject({
    method: "POST",
    url: `/channels/${channelId}/messages`,
    cookies: { rid: h.cookie },
    payload: { body },
  });
}

/** Bearer auth headers for an agent. */
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

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

describe("notifications & activity alerts (real Postgres + Redis)", () => {
  it("an @mention creates a durable notification, pushes a WS notification, and surfaces in inbox + unread count", async () => {
    const h = await newHuman("Lead");
    const cid = await createChannel(h, "general");
    const agent = await registerAgent(h, "Scout");

    // the agent connects but never subscribes — a notification reaches it regardless
    const agentClient = await open({ headers: bearer(agent.token) });
    await agentClient.waitFor((e) => e.type === "ready");

    await post(h, cid, "hey @Scout please take this");

    const evt = await agentClient.waitFor((e) => e.type === "notification");
    expect(evt).toMatchObject({
      type: "notification",
      notification: { type: "mention", recipientMemberId: agent.memberId, channelId: cid },
    });

    const inbox = await app.inject({
      method: "GET",
      url: "/me/notifications",
      headers: bearer(agent.token),
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json()).toHaveLength(1);
    expect(inbox.json()[0]).toMatchObject({ type: "mention", channelId: cid });

    const count = await app.inject({
      method: "GET",
      url: "/me/notifications/unread-count",
      headers: bearer(agent.token),
    });
    expect(count.json().count).toBe(1);

    // the author (who triggered the mention) is never notified of their own action
    const authorInbox = await app.inject({ method: "GET", url: "/me/notifications", cookies: { rid: h.cookie } });
    expect(authorInbox.json()).toHaveLength(0);

    agentClient.close();
  });

  it("a DM message notifies the other member (live + inbox), not the author", async () => {
    const a = await newHuman("Ann");
    const b = await registerAgent(a, "Buddy");
    const dm = await createDm(a, b.memberId);

    const bClient = await open({ headers: bearer(b.token) });
    await bClient.waitFor((e) => e.type === "ready");

    await post(a, dm, "ping — are you around?");

    const evt = await bClient.waitFor((e) => e.type === "notification");
    expect(evt).toMatchObject({
      type: "notification",
      notification: { type: "dm", recipientMemberId: b.memberId, channelId: dm },
    });

    const bInbox = await app.inject({ method: "GET", url: "/me/notifications", headers: bearer(b.token) });
    expect(bInbox.json()).toHaveLength(1);
    expect(bInbox.json()[0].type).toBe("dm");

    const aInbox = await app.inject({ method: "GET", url: "/me/notifications", cookies: { rid: a.cookie } });
    expect(aInbox.json()).toHaveLength(0);

    bClient.close();
  });

  it("assigning a task notifies the assignee (live + inbox)", async () => {
    const h = await newHuman("PM");
    const worker = await registerAgent(h, "Worker");

    const workerClient = await open({ headers: bearer(worker.token) });
    await workerClient.waitFor((e) => e.type === "ready");

    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/tasks`,
      cookies: { rid: h.cookie },
      payload: { title: "ship the thing", assigneeMemberId: worker.memberId },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().id as string;

    const evt = await workerClient.waitFor((e) => e.type === "notification");
    expect(evt).toMatchObject({
      type: "notification",
      notification: { type: "assignment", recipientMemberId: worker.memberId, taskId },
    });

    const inbox = await app.inject({ method: "GET", url: "/me/notifications", headers: bearer(worker.token) });
    expect(inbox.json()).toHaveLength(1);
    expect(inbox.json()[0]).toMatchObject({ type: "assignment", taskId });

    workerClient.close();
  });

  it("mention-only preference suppresses non-mention notifications but keeps mentions", async () => {
    const a = await newHuman("Owner");
    const b = await registerAgent(a, "Picky");

    const setPrefs = await app.inject({
      method: "PUT",
      url: "/me/notification-preferences",
      headers: bearer(b.token),
      payload: { mentionOnly: true },
    });
    expect(setPrefs.statusCode).toBe(200);
    expect(setPrefs.json()).toMatchObject({ muted: false, mentionOnly: true });

    // a DM to b is a non-mention activity → suppressed
    const dm = await createDm(a, b.memberId);
    await post(a, dm, "you around?");

    // an @mention of b still gets through
    const cid = await createChannel(a, "ops");
    await post(a, cid, "@Picky eyes on this please");

    const inbox = await app.inject({ method: "GET", url: "/me/notifications", headers: bearer(b.token) });
    expect(inbox.json()).toHaveLength(1);
    expect(inbox.json()[0].type).toBe("mention");
  });

  it("muting suppresses everything, including mentions", async () => {
    const a = await newHuman("Boss");
    const b = await registerAgent(a, "Silent");

    await app.inject({
      method: "PUT",
      url: "/me/notification-preferences",
      headers: bearer(b.token),
      payload: { muted: true },
    });

    const cid = await createChannel(a, "loud");
    await post(a, cid, "@Silent ping ping ping");

    const inbox = await app.inject({ method: "GET", url: "/me/notifications", headers: bearer(b.token) });
    expect(inbox.json()).toHaveLength(0);
    const count = await app.inject({
      method: "GET",
      url: "/me/notifications/unread-count",
      headers: bearer(b.token),
    });
    expect(count.json().count).toBe(0);
  });

  it("mark-read clears the unread count; the notification stays in the inbox", async () => {
    const a = await newHuman("Sender");
    const b = await registerAgent(a, "Reader");
    const cid = await createChannel(a, "thread");

    await post(a, cid, "@Reader one");
    await post(a, cid, "@Reader two");

    let count = await app.inject({ method: "GET", url: "/me/notifications/unread-count", headers: bearer(b.token) });
    expect(count.json().count).toBe(2);

    const inbox = await app.inject({ method: "GET", url: "/me/notifications", headers: bearer(b.token) });
    expect(inbox.json()).toHaveLength(2);
    const firstId = inbox.json()[0].id as string;

    // mark one read → unread drops to 1
    const markOne = await app.inject({ method: "POST", url: `/me/notifications/${firstId}/read`, headers: bearer(b.token) });
    expect(markOne.statusCode).toBe(200);
    count = await app.inject({ method: "GET", url: "/me/notifications/unread-count", headers: bearer(b.token) });
    expect(count.json().count).toBe(1);

    // mark all read → unread is 0, but the rows remain in the inbox with read_at set
    const markAll = await app.inject({ method: "POST", url: "/me/notifications/read-all", headers: bearer(b.token) });
    expect(markAll.json().marked).toBe(1);
    count = await app.inject({ method: "GET", url: "/me/notifications/unread-count", headers: bearer(b.token) });
    expect(count.json().count).toBe(0);

    const after = await app.inject({ method: "GET", url: "/me/notifications", headers: bearer(b.token) });
    expect(after.json()).toHaveLength(2);
    expect(after.json().every((n: { readAt: string | null }) => n.readAt !== null)).toBe(true);

    // ?unread=true now returns nothing
    const unreadOnly = await app.inject({ method: "GET", url: "/me/notifications?unread=true", headers: bearer(b.token) });
    expect(unreadOnly.json()).toHaveLength(0);
  });

  it("a member only sees their own notifications — no cross-member or cross-workspace leakage", async () => {
    // workspace 1: a mentions agent b
    const a = await newHuman("WsOneLead");
    const b = await registerAgent(a, "Mine");
    const cid = await createChannel(a, "private");
    await post(a, cid, "@Mine this is yours");

    const bInbox = await app.inject({ method: "GET", url: "/me/notifications", headers: bearer(b.token) });
    expect(bInbox.json()).toHaveLength(1);
    const bNotifId = bInbox.json()[0].id as string;

    // the author sees none of b's notifications
    const aInbox = await app.inject({ method: "GET", url: "/me/notifications", cookies: { rid: a.cookie } });
    expect(aInbox.json()).toHaveLength(0);

    // cross-member (same workspace): a cannot mark b's notification read → 404 (IDOR guard)
    const aMarksB = await app.inject({ method: "POST", url: `/me/notifications/${bNotifId}/read`, cookies: { rid: a.cookie } });
    expect(aMarksB.statusCode).toBe(404);

    // cross-workspace: a member in a different workspace sees nothing and cannot touch b's notification
    const c = await newHuman("WsTwoLead");
    const cInbox = await app.inject({ method: "GET", url: "/me/notifications", cookies: { rid: c.cookie } });
    expect(cInbox.json()).toHaveLength(0);
    const cCount = await app.inject({ method: "GET", url: "/me/notifications/unread-count", cookies: { rid: c.cookie } });
    expect(cCount.json().count).toBe(0);
    const cMarksB = await app.inject({ method: "POST", url: `/me/notifications/${bNotifId}/read`, cookies: { rid: c.cookie } });
    expect(cMarksB.statusCode).toBe(404);

    // b's notification is untouched (still unread) after the cross-member/workspace attempts
    const bCount = await app.inject({ method: "GET", url: "/me/notifications/unread-count", headers: bearer(b.token) });
    expect(bCount.json().count).toBe(1);
  });
});
