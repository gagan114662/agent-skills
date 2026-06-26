import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

/**
 * #11 — framework-agnostic REST agent interface. Proves an external agent holding ONLY a
 * Bearer token can complete the documented flow through stable endpoints:
 *   whoami → list channels it can access → post → read mentions
 * and that the surface stays workspace-scoped (#3 IDOR) and capability-respecting (#9).
 */

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
  const slug = `ai-${newId()}`;
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

/** Mint an agent token (human-authed). `name` doubles as the @mention handle. */
async function newAgent(
  owner: { cookie: string; workspaceId: string },
  name: string,
  framework?: string,
): Promise<{ memberId: string; agentId: string; token: string }> {
  const reg = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/agents`,
      cookies: { rid: owner.cookie },
      payload: { name, framework },
    })
  ).json();
  return { memberId: reg.memberId, agentId: reg.agentId, token: reg.token };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function createChannel(
  owner: { cookie: string; workspaceId: string },
  name: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/channels`,
    cookies: { rid: owner.cookie },
    payload: { name },
  });
  return res.json().id as string;
}

/** Owner (propagate on channels it created) grants a capability to a member; auto-adds them. */
async function grant(
  owner: { cookie: string },
  channelId: string,
  memberId: string,
  capability: "read" | "write" | "propagate",
): Promise<void> {
  await app.inject({
    method: "POST",
    url: `/channels/${channelId}/grants`,
    cookies: { rid: owner.cookie },
    payload: { memberId, capability },
  });
}

describe("#11 agent REST interface (real Postgres)", () => {
  it("registers a bring-your-own MCP agent and lets it participate in a channel (#514)", async () => {
    const owner = await newOwner();
    const handle = `mcpguest${newId().replace(/-/g, "")}`;
    const agent = await newAgent(owner, handle, "mcp");
    const general = await createChannel(owner, "general");
    await grant(owner, general, agent.memberId, "write");

    const registry = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/agents`,
      cookies: { rid: owner.cookie },
    });
    expect(registry.statusCode).toBe(200);
    expect(registry.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: agent.agentId, name: handle, framework: "mcp" }),
      ]),
    );

    const me = await app.inject({ method: "GET", url: "/me", headers: bearer(agent.token) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      kind: "agent",
      workspaceId: owner.workspaceId,
      memberId: agent.memberId,
      displayName: handle,
    });

    const post = await app.inject({
      method: "POST",
      url: `/channels/${general}/messages`,
      headers: bearer(agent.token),
      payload: { body: "external MCP agent online" },
    });
    expect(post.statusCode).toBe(201);

    const messages = await app.inject({
      method: "GET",
      url: `/channels/${general}/messages`,
      headers: bearer(agent.token),
    });
    expect(messages.statusCode).toBe(200);
    expect((messages.json() as { body: string }[]).map((m) => m.body)).toContain(
      "external MCP agent online",
    );
  });

  it("an agent with only a Bearer token completes whoami → channels → post → mentions", async () => {
    const owner = await newOwner();
    const handle = `watcher${newId().replace(/-/g, "")}`;
    const agent = await newAgent(owner, handle);

    const general = await createChannel(owner, "general");
    const readOnly = await createChannel(owner, "read-only");
    const priv = await createChannel(owner, "private");
    await grant(owner, general, agent.memberId, "write");
    await grant(owner, readOnly, agent.memberId, "read");
    // `priv` is intentionally left ungranted → the agent must NOT see it.

    // 1. whoami — identity + workspace, from the token alone.
    const me = await app.inject({ method: "GET", url: "/me", headers: bearer(agent.token) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      kind: "agent",
      workspaceId: owner.workspaceId,
      memberId: agent.memberId,
      displayName: handle,
    });

    // 2. list channels it can access — capability-filtered, annotated, no leakage of `private`.
    const chans = await app.inject({
      method: "GET",
      url: "/me/channels",
      headers: bearer(agent.token),
    });
    expect(chans.statusCode).toBe(200);
    const byId = new Map<string, { capability: string }>(
      (chans.json() as { id: string; capability: string }[]).map((c) => [c.id, c]),
    );
    expect(byId.get(general)?.capability).toBe("write");
    expect(byId.get(readOnly)?.capability).toBe("read");
    expect(byId.has(priv)).toBe(false);

    // 3. post a message into a channel it has write on.
    const post = await app.inject({
      method: "POST",
      url: `/channels/${general}/messages`,
      headers: bearer(agent.token),
      payload: { body: "agent reporting in" },
    });
    expect(post.statusCode).toBe(201);

    // 4. another member @mentions the agent → it reads its mentions.
    const mention = await app.inject({
      method: "POST",
      url: `/channels/${general}/messages`,
      cookies: { rid: owner.cookie },
      payload: { body: `@${handle} please review` },
    });
    expect(mention.statusCode).toBe(201);

    const mentions = await app.inject({
      method: "GET",
      url: "/me/mentions",
      headers: bearer(agent.token),
    });
    expect(mentions.statusCode).toBe(200);
    expect((mentions.json() as { body: string }[]).map((m) => m.body)).toContain(
      `@${handle} please review`,
    );

    const count = await app.inject({
      method: "GET",
      url: "/me/mentions/count",
      headers: bearer(agent.token),
    });
    expect(count.json().count).toBeGreaterThanOrEqual(1);
  });

  it("read-only on a channel cannot be escalated to a post through the interface", async () => {
    const owner = await newOwner();
    const agent = await newAgent(owner, `ro${newId().replace(/-/g, "")}`);
    const ch = await createChannel(owner, "announce");
    await grant(owner, ch, agent.memberId, "read");

    // It appears in /me/channels as read…
    const chans = await app.inject({
      method: "GET",
      url: "/me/channels",
      headers: bearer(agent.token),
    });
    const entry = (chans.json() as { id: string; capability: string }[]).find((c) => c.id === ch);
    expect(entry?.capability).toBe("read");

    // …but posting is still 403 (capability respected, #9).
    const post = await app.inject({
      method: "POST",
      url: `/channels/${ch}/messages`,
      headers: bearer(agent.token),
      payload: { body: "should be blocked" },
    });
    expect(post.statusCode).toBe(403);
  });

  it("a token from another workspace is rejected for cross-workspace resources (#3 IDOR)", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const agentB = await newAgent(b, `intruder${newId().replace(/-/g, "")}`);
    const generalA = await createChannel(a, "secrets");

    // whoami for B's token reports B's workspace, never A's.
    const me = await app.inject({ method: "GET", url: "/me", headers: bearer(agentB.token) });
    expect(me.json().workspaceId).toBe(b.workspaceId);
    expect(me.json().workspaceId).not.toBe(a.workspaceId);

    // B's token cannot read or post into A's channel — 404 (not even existence leaks).
    const read = await app.inject({
      method: "GET",
      url: `/channels/${generalA}/messages`,
      headers: bearer(agentB.token),
    });
    expect(read.statusCode).toBe(404);
    const post = await app.inject({
      method: "POST",
      url: `/channels/${generalA}/messages`,
      headers: bearer(agentB.token),
      payload: { body: "leak attempt" },
    });
    expect(post.statusCode).toBe(404);

    // B's accessible-channel list never contains A's channel.
    const chans = await app.inject({
      method: "GET",
      url: "/me/channels",
      headers: bearer(agentB.token),
    });
    expect((chans.json() as { id: string }[]).some((c) => c.id === generalA)).toBe(false);
  });

  it("rejects unauthenticated access to /me/channels", async () => {
    const res = await app.inject({ method: "GET", url: "/me/channels" });
    expect(res.statusCode).toBe(401);
  });

  it("publishes the OpenAPI contract at /openapi.json (public, no auth)", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/me/channels"].get).toBeDefined();
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });
});
