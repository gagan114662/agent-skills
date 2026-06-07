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

interface Tenant {
  cookie: string;
  workspaceId: string;
  memberId: string;
  agentToken: string;
}

/** Stand up a fresh, isolated workspace with a human (session) and an agent (token). */
async function newTenant(): Promise<Tenant> {
  const slug = `iso-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  const agent = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${me.workspaceId}/agents`,
      cookies: { rid: cookie },
      payload: { name: "Agent" },
    })
  ).json();
  return {
    cookie,
    workspaceId: me.workspaceId,
    memberId: me.memberId,
    agentToken: agent.token as string,
  };
}

describe("tenant isolation (real Postgres) — workspace A cannot reach workspace B", () => {
  it("a member of B cannot read, list, or post into A's workspace/channels", async () => {
    const a = await newTenant();
    const b = await newTenant();
    expect(a.workspaceId).not.toBe(b.workspaceId);

    // A creates a private-ish channel and posts a message in its own workspace.
    const channelId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${a.workspaceId}/channels`,
        cookies: { rid: a.cookie },
        payload: { name: "secrets" },
      })
    ).json().id as string;
    await app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      cookies: { rid: a.cookie },
      payload: { body: "top secret" },
    });

    // Positive control: A can read its own channel (proves the assertions below aren't trivially true).
    const ownRead = await app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages`,
      cookies: { rid: a.cookie },
    });
    expect(ownRead.statusCode).toBe(200);
    expect(ownRead.json().map((m: { body: string }) => m.body)).toContain("top secret");

    // 1. B's human cannot list A's channels (workspace mismatch → 403).
    const listAsB = await app.inject({
      method: "GET",
      url: `/workspaces/${a.workspaceId}/channels`,
      cookies: { rid: b.cookie },
    });
    expect(listAsB.statusCode).toBe(403);

    // 2. B's human cannot create a channel in A's workspace (→ 403).
    const createAsB = await app.inject({
      method: "POST",
      url: `/workspaces/${a.workspaceId}/channels`,
      cookies: { rid: b.cookie },
      payload: { name: "intruder" },
    });
    expect(createAsB.statusCode).toBe(403);

    // 3. B's agent token cannot read A's channel messages (cross-workspace → 404).
    const readAsBAgent = await app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${b.agentToken}` },
    });
    expect(readAsBAgent.statusCode).toBe(404);

    // 4. B's agent token cannot post into A's channel (→ 404).
    const postAsBAgent = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${b.agentToken}` },
      payload: { body: "leak" },
    });
    expect(postAsBAgent.statusCode).toBe(404);

    // 5. Leak check: A's secret never appears in any of B's response bodies.
    for (const res of [listAsB, createAsB, readAsBAgent, postAsBAgent]) {
      expect(res.body).not.toContain("top secret");
    }
  });
});
