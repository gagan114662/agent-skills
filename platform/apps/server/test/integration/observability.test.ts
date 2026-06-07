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

describe("observability (real Postgres + Redis)", () => {
  it("GET /readyz reports ready with both dependencies up", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", db: "up", redis: "up" });
  });

  it("echoes the correlation id on an authenticated request (end-to-end trace)", async () => {
    const slug = `obs-${newId()}`;
    slugs.push(slug);
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        email: `u-${newId()}@e.com`,
        password: "pw",
        displayName: "U",
        workspaceSlug: slug,
      },
    });
    const cookie = signup.cookies.find((c) => c.name === "rid")!.value;

    const res = await app.inject({
      method: "GET",
      url: "/me",
      cookies: { rid: cookie },
      headers: { "x-request-id": "e2e-trace-007" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe("e2e-trace-007");
  });
});
