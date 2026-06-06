import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

let app: FastifyInstance;
const createdWorkspaceSlugs: string[] = [];

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  for (const slug of createdWorkspaceSlugs) {
    await db.delete(workspaces).where(eq(workspaces.slug, slug));
  }
  await app.close();
  await closeDb();
});

function sessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string {
  const c = res.cookies.find((x) => x.name === "rid");
  if (!c) throw new Error("no session cookie set");
  return c.value;
}

describe("auth & identity (real Postgres)", () => {
  it("signup → session → /me resolves the human member; agent token → /me resolves the agent; revoke → 401", async () => {
    const slug = `auth-${newId()}`;
    createdWorkspaceSlugs.push(slug);
    const email = `h-${newId()}@example.com`;

    // signup
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password: "s3cret-pw", displayName: "Gagan", workspaceSlug: slug },
    });
    expect(signup.statusCode).toBe(201);
    const cookie = sessionCookie(signup);

    // /me as human
    const meHuman = await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } });
    expect(meHuman.statusCode).toBe(200);
    expect(meHuman.json()).toMatchObject({ kind: "human", displayName: "Gagan" });
    const workspaceId = meHuman.json().workspaceId as string;

    // register an agent (human-authed)
    const reg = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agents`,
      cookies: { rid: cookie },
      payload: { name: "Scout", framework: "mcp" },
    });
    expect(reg.statusCode).toBe(201);
    const { token, agentId, tokenId } = reg.json() as {
      token: string;
      agentId: string;
      tokenId: string;
    };
    expect(token.startsWith("rld_agt_")).toBe(true);

    // /me as agent (Bearer)
    const meAgent = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meAgent.statusCode).toBe(200);
    expect(meAgent.json()).toMatchObject({ kind: "agent", workspaceId });

    // revoke the token → /me with it now 401
    const revoke = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/agents/${agentId}/tokens/${tokenId}/revoke`,
      cookies: { rid: cookie },
    });
    expect(revoke.statusCode).toBe(200);

    const meRevoked = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRevoked.statusCode).toBe(401);
  });

  it("login succeeds with correct password and 401s on a wrong one", async () => {
    const slug = `auth-${newId()}`;
    createdWorkspaceSlugs.push(slug);
    const email = `h-${newId()}@example.com`;
    await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password: "right-pw", displayName: "U", workspaceSlug: slug },
    });

    const ok = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "right-pw" },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "WRONG" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("rejects unauthenticated /me", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
  });

  it("does not let a human revoke a token belonging to another workspace (IDOR)", async () => {
    // workspace A + human A
    const slugA = `auth-${newId()}`;
    createdWorkspaceSlugs.push(slugA);
    const signA = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: `a-${newId()}@e.com`, password: "pw", displayName: "A", workspaceSlug: slugA },
    });
    const cookieA = sessionCookie(signA);
    const wsA = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookieA } })).json()
      .workspaceId as string;

    // workspace B + human B + an agent token in B
    const slugB = `auth-${newId()}`;
    createdWorkspaceSlugs.push(slugB);
    const signB = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: `b-${newId()}@e.com`, password: "pw", displayName: "B", workspaceSlug: slugB },
    });
    const cookieB = sessionCookie(signB);
    const wsB = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookieB } })).json()
      .workspaceId as string;
    const regB = await app.inject({
      method: "POST",
      url: `/workspaces/${wsB}/agents`,
      cookies: { rid: cookieB },
      payload: { name: "BScout" },
    });
    const { token: tokenB, agentId: agentB, tokenId: tokenIdB } = regB.json() as {
      token: string;
      agentId: string;
      tokenId: string;
    };

    // A uses its OWN workspace in the path (passing the membership check) but B's token id.
    const attempt = await app.inject({
      method: "POST",
      url: `/workspaces/${wsA}/agents/${agentB}/tokens/${tokenIdB}/revoke`,
      cookies: { rid: cookieA },
    });
    expect(attempt.statusCode).toBe(404); // not found *in A's workspace*

    // B's token must still be valid — A's cross-tenant attempt did nothing.
    const meB = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(meB.statusCode).toBe(200);
  });
});
