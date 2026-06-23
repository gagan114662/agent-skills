import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
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

/** Sign up a fresh human in a fresh workspace; return their cookie, workspaceId, memberId. */
async function newHuman(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `ch-${newId()}`;
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

describe("channels & DMs (real Postgres)", () => {
  it("create channel → post message (REST) → read it back", async () => {
    const h = await newHuman();
    const create = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/channels`,
      cookies: { rid: h.cookie },
      payload: { name: "general" },
    });
    expect(create.statusCode).toBe(201);
    const cid = create.json().id as string;

    const post = await app.inject({
      method: "POST",
      url: `/channels/${cid}/messages`,
      cookies: { rid: h.cookie },
      payload: { body: "hello world" },
    });
    expect(post.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: `/channels/${cid}/messages`,
      cookies: { rid: h.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((m: { body: string }) => m.body)).toContain("hello world");
  });

  it("tails channel history when a message limit is provided", async () => {
    const h = await newHuman();
    const create = await app.inject({
      method: "POST",
      url: "/workspaces/" + h.workspaceId + "/channels",
      cookies: { rid: h.cookie },
      payload: { name: "history" },
    });
    const cid = create.json().id as string;

    for (let i = 0; i < 5; i += 1) {
      const post = await app.inject({
        method: "POST",
        url: "/channels/" + cid + "/messages",
        cookies: { rid: h.cookie },
        payload: { body: "message " + i },
      });
      expect(post.statusCode).toBe(201);
    }

    const list = await app.inject({
      method: "GET",
      url: "/channels/" + cid + "/messages?limit=2",
      cookies: { rid: h.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((m: { body: string }) => m.body)).toEqual(["message 3", "message 4"]);
  });

  it("DM get-or-create is idempotent for the same member set", async () => {
    const h = await newHuman();
    const reg = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/agents`,
      cookies: { rid: h.cookie },
      payload: { name: "Scout" },
    });
    const agentMemberId = reg.json().memberId as string;

    const dm1 = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/dms`,
      cookies: { rid: h.cookie },
      payload: { memberIds: [agentMemberId] },
    });
    const dm2 = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/dms`,
      cookies: { rid: h.cookie },
      payload: { memberIds: [agentMemberId] },
    });
    expect(dm1.statusCode).toBe(200);
    expect(dm1.json().id).toBe(dm2.json().id); // same DM, not a duplicate
  });

  it("archived channels are hidden from the list and reject new messages", async () => {
    const h = await newHuman();
    const cid = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${h.workspaceId}/channels`,
        cookies: { rid: h.cookie },
        payload: { name: "temp" },
      })
    ).json().id as string;

    await app.inject({ method: "POST", url: `/channels/${cid}/archive`, cookies: { rid: h.cookie } });

    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${h.workspaceId}/channels`,
      cookies: { rid: h.cookie },
    });
    expect(list.json().map((c: { id: string }) => c.id)).not.toContain(cid);

    const post = await app.inject({
      method: "POST",
      url: `/channels/${cid}/messages`,
      cookies: { rid: h.cookie },
      payload: { body: "nope" },
    });
    expect(post.statusCode).toBe(409);
  });

  it("a workspace member who is not in the channel cannot read it (403)", async () => {
    const h = await newHuman();
    const cid = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${h.workspaceId}/channels`,
        cookies: { rid: h.cookie },
        payload: { name: "private-ish" },
      })
    ).json().id as string;

    // an agent: a workspace member, but NOT added to the channel
    const token = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${h.workspaceId}/agents`,
        cookies: { rid: h.cookie },
        payload: { name: "Outsider" },
      })
    ).json().token as string;

    const read = await app.inject({
      method: "GET",
      url: `/channels/${cid}/messages`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(403);
  });
});
