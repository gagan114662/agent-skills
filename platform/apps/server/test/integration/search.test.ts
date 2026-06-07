import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces, messages } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

let app: FastifyInstance;
const slugs: string[] = [];

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await closeDb();
});

interface Owner {
  cookie: string;
  workspaceId: string;
  memberId: string;
}

async function newOwner(): Promise<Owner> {
  const slug = `search-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      email: `u-${newId()}@e.com`,
      password: "pw",
      displayName: "Owner",
      workspaceSlug: slug,
    },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

async function newAgent(owner: Owner, name: string): Promise<{ memberId: string; token: string }> {
  const reg = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/agents`,
      cookies: { rid: owner.cookie },
      payload: { name },
    })
  ).json();
  return { memberId: reg.memberId, token: reg.token };
}

async function createChannel(owner: Owner, name = "general"): Promise<string> {
  return (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/channels`,
      cookies: { rid: owner.cookie },
      payload: { name },
    })
  ).json().id as string;
}

async function post(
  owner: Owner,
  cid: string,
  body: string,
  parentMessageId?: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/channels/${cid}/messages`,
    cookies: { rid: owner.cookie },
    payload: { body, parentMessageId },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

function searchMessages(
  auth: { cookie?: string; token?: string },
  wid: string,
  params: Record<string, string>,
) {
  const qs = new URLSearchParams({ ...params }).toString();
  return app.inject({
    method: "GET",
    url: `/workspaces/${wid}/search/messages?${qs}`,
    headers: auth.token ? { authorization: `Bearer ${auth.token}` } : undefined,
    cookies: auth.cookie ? { rid: auth.cookie } : undefined,
  });
}

describe("Search: permission-scoped messages & channels (real Postgres) (#7)", () => {
  it("a channel member finds a matching message, ranked", async () => {
    const owner = await newOwner();
    const cid = await createChannel(owner);
    const id = await post(owner, cid, "the deploy pipeline is finally green");

    const res = await searchMessages(owner, owner.workspaceId, { q: "deploy" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.map((r: { id: string }) => r.id)).toContain(id);
    const hit = body.results.find((r: { id: string }) => r.id === id);
    expect(typeof hit.rank).toBe("number");
    expect(hit.rank).toBeGreaterThan(0);
  });

  it("does NOT leak: a workspace member who is not in the channel gets zero hits for the same query", async () => {
    const owner = await newOwner();
    const cid = await createChannel(owner);
    await post(owner, cid, "secret deploy plan for the rocket");
    const outsider = await newAgent(owner, "Outsider"); // same workspace, not a channel member

    const mine = await searchMessages(owner, owner.workspaceId, { q: "rocket" });
    expect(mine.json().results.length).toBeGreaterThan(0);

    const theirs = await searchMessages({ token: outsider.token }, owner.workspaceId, {
      q: "rocket",
    });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().results).toEqual([]);
  });

  it("does NOT leak across workspaces (tenant isolation)", async () => {
    const owner = await newOwner();
    const cid = await createChannel(owner);
    await post(owner, cid, "cross tenant confidential phrase");
    const other = await newOwner(); // different workspace

    // querying their own workspace finds nothing
    const own = await searchMessages(other, other.workspaceId, { q: "confidential" });
    expect(own.json().results).toEqual([]);

    // querying the victim's workspace id is rejected by the workspace guard
    const cross = await searchMessages(other, owner.workspaceId, { q: "confidential" });
    expect(cross.statusCode).toBe(403);
  });

  it("ranks and paginates", async () => {
    const owner = await newOwner();
    const cid = await createChannel(owner);
    for (let i = 0; i < 5; i++) await post(owner, cid, `widget report number ${i}`);

    const page1 = await searchMessages(owner, owner.workspaceId, {
      q: "widget",
      limit: "2",
      offset: "0",
    });
    const page2 = await searchMessages(owner, owner.workspaceId, {
      q: "widget",
      limit: "2",
      offset: "2",
    });
    expect(page1.json().results.length).toBe(2);
    expect(page2.json().results.length).toBe(2);
    const ids1 = page1.json().results.map((r: { id: string }) => r.id);
    const ids2 = page2.json().results.map((r: { id: string }) => r.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false); // no overlap
  });

  it("filters narrow results (channel, author, thread)", async () => {
    const owner = await newOwner();
    const c1 = await createChannel(owner, "one");
    const c2 = await createChannel(owner, "two");
    await post(owner, c1, "harmonica solo in channel one");
    await post(owner, c2, "harmonica solo in channel two");

    // channelId filter
    const byChannel = await searchMessages(owner, owner.workspaceId, {
      q: "harmonica",
      channelId: c1,
    });
    const chans = new Set(byChannel.json().results.map((r: { channelId: string }) => r.channelId));
    expect([...chans]).toEqual([c1]);

    // authorMemberId filter
    const byAuthor = await searchMessages(owner, owner.workspaceId, {
      q: "harmonica",
      authorMemberId: owner.memberId,
    });
    expect(byAuthor.json().results.length).toBeGreaterThan(0);
    const wrongAuthor = await searchMessages(owner, owner.workspaceId, {
      q: "harmonica",
      authorMemberId: newId(),
    });
    expect(wrongAuthor.json().results).toEqual([]);

    // threadId filter (replies under a parent)
    const parent = await post(owner, c1, "thread root about kazoo");
    await post(owner, c1, "kazoo reply one", parent);
    const byThread = await searchMessages(owner, owner.workspaceId, {
      q: "kazoo",
      threadId: parent,
    });
    const parents = new Set(
      byThread.json().results.map((r: { parentMessageId: string }) => r.parentMessageId),
    );
    expect([...parents]).toEqual([parent]);
  });

  it("an unreadable channelId filter returns empty (no existence oracle)", async () => {
    const owner = await newOwner();
    const cid = await createChannel(owner);
    await post(owner, cid, "private xylophone discussion");
    const outsider = await newAgent(owner, "Nosy");

    const res = await searchMessages({ token: outsider.token }, owner.workspaceId, {
      q: "xylophone",
      channelId: cid,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([]);
  });

  it("keeps the FTS index correct across edits and deletes", async () => {
    const owner = await newOwner();
    const cid = await createChannel(owner);

    // delete: soft-deleted messages drop out of results
    const ephemeral = await post(owner, cid, "ephemeral trombone note");
    expect(
      (await searchMessages(owner, owner.workspaceId, { q: "trombone" })).json().results.length,
    ).toBe(1);
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, ephemeral));
    expect(
      (await searchMessages(owner, owner.workspaceId, { q: "trombone" })).json().results,
    ).toEqual([]);

    // edit: the generated tsvector recomputes, flipping which query matches
    const edited = await post(owner, cid, "originalword saxophone");
    expect(
      (await searchMessages(owner, owner.workspaceId, { q: "originalword" }))
        .json()
        .results.map((r: { id: string }) => r.id),
    ).toContain(edited);
    await db
      .update(messages)
      .set({ body: "replacedword saxophone" })
      .where(eq(messages.id, edited));
    expect(
      (await searchMessages(owner, owner.workspaceId, { q: "originalword" })).json().results,
    ).toEqual([]);
    expect(
      (await searchMessages(owner, owner.workspaceId, { q: "replacedword" }))
        .json()
        .results.map((r: { id: string }) => r.id),
    ).toContain(edited);
  });

  it("requires a q", async () => {
    const owner = await newOwner();
    const res = await searchMessages(owner, owner.workspaceId, {});
    expect(res.statusCode).toBe(400);
  });

  it("channel-name search returns only the caller's channels; member search is workspace-scoped", async () => {
    const owner = await newOwner();
    await createChannel(owner, "engineering");
    const other = await newOwner();
    await createChannel(other, "engineering");

    const chans = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/search/channels?q=engineering`,
      cookies: { rid: owner.cookie },
    });
    expect(chans.statusCode).toBe(200);
    const chanWs = new Set(chans.json().results.map((c: { workspaceId: string }) => c.workspaceId));
    expect([...chanWs]).toEqual([owner.workspaceId]);

    const members = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/search/members?q=Owner`,
      cookies: { rid: owner.cookie },
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().results.length).toBeGreaterThan(0);
    expect(members.json().results.every((m: { id: string }) => typeof m.id === "string")).toBe(
      true,
    );
  });

  it("rejects an unauthenticated caller", async () => {
    const owner = await newOwner();
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/search/messages?q=anything`,
    });
    expect(res.statusCode).toBe(401);
  });
});
