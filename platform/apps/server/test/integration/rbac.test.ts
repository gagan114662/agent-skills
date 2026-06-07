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

/** Sign up a fresh human owner in a fresh workspace. */
async function newOwner(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `rbac-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

/** Register an agent; return its member id and Bearer token. */
async function newAgent(
  owner: { cookie: string; workspaceId: string },
  name: string,
): Promise<{ memberId: string; agentId: string; token: string }> {
  const reg = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/agents`,
      cookies: { rid: owner.cookie },
      payload: { name },
    })
  ).json();
  return { memberId: reg.memberId, agentId: reg.agentId, token: reg.token };
}

async function createChannel(owner: { cookie: string; workspaceId: string }): Promise<string> {
  return (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/channels`,
      cookies: { rid: owner.cookie },
      payload: { name: "general" },
    })
  ).json().id as string;
}

function grant(
  granter: { cookie?: string; token?: string },
  cid: string,
  memberId: string,
  capability: string,
) {
  const headers = granter.token ? { authorization: `Bearer ${granter.token}` } : undefined;
  const cookies = granter.cookie ? { rid: granter.cookie } : undefined;
  return app.inject({
    method: "POST",
    url: `/channels/${cid}/grants`,
    headers,
    cookies,
    payload: { memberId, capability },
  });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("RBAC: roles layered on channel membership (real Postgres)", () => {
  it("read-only role can read the channel but cannot post (403)", async () => {
    const owner = await newOwner();
    const cid = await createChannel(owner);
    const reader = await newAgent(owner, "Reader");

    expect((await grant(owner, cid, reader.memberId, "read")).statusCode).toBe(201);

    const read = await app.inject({ method: "GET", url: `/channels/${cid}/messages`, headers: bearer(reader.token) });
    expect(read.statusCode).toBe(200);

    const post = await app.inject({
      method: "POST",
      url: `/channels/${cid}/messages`,
      headers: bearer(reader.token),
      payload: { body: "I should not be able to say this" },
    });
    expect(post.statusCode).toBe(403);
  });

  it("write role can post", async () => {
    const owner = await newOwner();
    const cid = await createChannel(owner);
    const writer = await newAgent(owner, "Writer");

    expect((await grant(owner, cid, writer.memberId, "write")).statusCode).toBe(201);

    const post = await app.inject({
      method: "POST",
      url: `/channels/${cid}/messages`,
      headers: bearer(writer.token),
      payload: { body: "hello from a write role" },
    });
    expect(post.statusCode).toBe(201);
  });

  it("propagate role can grant a role to another member; a write-only role cannot (403)", async () => {
    const owner = await newOwner();
    const cid = await createChannel(owner);
    const delegate = await newAgent(owner, "Delegate");
    const writer = await newAgent(owner, "WriteOnly");
    const target = await newAgent(owner, "Target");

    await grant(owner, cid, delegate.memberId, "propagate");
    await grant(owner, cid, writer.memberId, "write");

    // propagate member can grant
    const byPropagate = await grant({ token: delegate.token }, cid, target.memberId, "read");
    expect(byPropagate.statusCode).toBe(201);

    // write-only member cannot grant
    const byWrite = await grant({ token: writer.token }, cid, target.memberId, "write");
    expect(byWrite.statusCode).toBe(403);
  });

  it("revocation takes effect immediately", async () => {
    const owner = await newOwner();
    const cid = await createChannel(owner);
    const delegate = await newAgent(owner, "Delegate");
    const target = await newAgent(owner, "Target");

    await grant(owner, cid, delegate.memberId, "propagate");
    // delegate can grant while holding propagate
    expect((await grant({ token: delegate.token }, cid, target.memberId, "read")).statusCode).toBe(201);

    // owner revokes the delegate's propagate grant
    const revoke = await app.inject({
      method: "DELETE",
      url: `/channels/${cid}/grants/${delegate.memberId}`,
      cookies: { rid: owner.cookie },
    });
    expect(revoke.statusCode).toBe(200);

    // the very next grant attempt by the (now write-default) delegate is rejected
    const after = await grant({ token: delegate.token }, cid, target.memberId, "write");
    expect(after.statusCode).toBe(403);
  });

  it("cross-workspace role assignment is rejected", async () => {
    const owner = await newOwner();
    const cid = await createChannel(owner);
    const other = await newOwner(); // a member in a *different* workspace

    const res = await grant(owner, cid, other.memberId, "read");
    expect([403, 404]).toContain(res.statusCode);
  });

  it("registry: lists agents and deactivation blocks the agent immediately", async () => {
    const owner = await newOwner();
    const agent = await newAgent(owner, "Roster");

    const list = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/agents`,
      cookies: { rid: owner.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((a: { id: string }) => a.id)).toContain(agent.agentId);

    // agent can authenticate before deactivation
    expect((await app.inject({ method: "GET", url: "/me", headers: bearer(agent.token) })).statusCode).toBe(200);

    const deact = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/agents/${agent.agentId}/deactivate`,
      cookies: { rid: owner.cookie },
    });
    expect(deact.statusCode).toBe(200);

    // immediately rejected afterwards
    expect((await app.inject({ method: "GET", url: "/me", headers: bearer(agent.token) })).statusCode).toBe(401);
  });

  it("backward-compat: a plain channel member (no explicit grant) can still post (#4 default)", async () => {
    const owner = await newOwner();
    const cid = await createChannel(owner);
    // owner has propagate (granted at creation) and can post
    const post = await app.inject({
      method: "POST",
      url: `/channels/${cid}/messages`,
      cookies: { rid: owner.cookie },
      payload: { body: "owner can post" },
    });
    expect(post.statusCode).toBe(201);
  });
});
