import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";

/**
 * #68 — Settings → Connect Claude API. The owner connects a per-tenant Claude subscription token; the
 * API never echoes the token back, only the connected/not-connected + fingerprint state.
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
  await closeRedis();
});

function cookieOf(res: { cookies: Array<{ name: string; value: string }> }): string {
  const c = res.cookies.find((x) => x.name === "rid");
  if (!c) throw new Error("no session cookie");
  return c.value;
}

async function signup(): Promise<string> {
  const slug = `cred-api-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  slugs.push(slug);
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `${slug}@example.com`, password: "hunter2hunter2", displayName: "Owner", workspaceSlug: slug },
  });
  expect(res.statusCode).toBe(201);
  return cookieOf(res);
}

describe("Connect Claude credentials API (#68)", () => {
  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/me/agent-credentials" });
    expect(res.statusCode).toBe(401);
  });

  it("reports not-connected for a fresh workspace", async () => {
    const rid = await signup();
    const res = await app.inject({ method: "GET", url: "/me/agent-credentials", cookies: { rid } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: false, fingerprint: null });
  });

  it("connects a token, reports connected, and NEVER echoes the token back", async () => {
    const rid = await signup();
    const put = await app.inject({
      method: "PUT",
      url: "/me/agent-credentials",
      cookies: { rid },
      payload: { token: "sk-ant-oat-secret-value" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain("sk-ant-oat-secret-value");
    expect(put.json()).toMatchObject({ connected: true });
    expect(put.json().fingerprint).toBeTruthy();

    const get = await app.inject({ method: "GET", url: "/me/agent-credentials", cookies: { rid } });
    expect(get.json()).toMatchObject({ connected: true });
    expect(get.body).not.toContain("sk-ant-oat-secret-value");
  });

  it("rejects a blank token", async () => {
    const rid = await signup();
    const res = await app.inject({
      method: "PUT",
      url: "/me/agent-credentials",
      cookies: { rid },
      payload: { token: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("disconnects", async () => {
    const rid = await signup();
    await app.inject({ method: "PUT", url: "/me/agent-credentials", cookies: { rid }, payload: { token: "tok" } });
    const del = await app.inject({ method: "DELETE", url: "/me/agent-credentials", cookies: { rid } });
    expect(del.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/me/agent-credentials", cookies: { rid } });
    expect(get.json()).toMatchObject({ connected: false });
  });
});
