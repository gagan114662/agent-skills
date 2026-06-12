import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

/**
 * Workspace catalog (#152) over real Postgres. Proves CRUD + the #3 tenant boundary + the default-OFF
 * gate. The catalog flag is the per-tenant config read by the routes; the env layer flips it on for the
 * whole test process (`RELOAD_CATALOG_ENABLED`).
 */

const app: FastifyInstance = buildApp({});
const slugs: string[] = [];

beforeAll(() => {
  process.env.RELOAD_CATALOG_ENABLED = "true";
});

afterAll(async () => {
  delete process.env.RELOAD_CATALOG_ENABLED;
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  workspaceId: string;
  cookie: string;
}

async function seed(): Promise<World> {
  const slug = `cat-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { workspaceId: me.workspaceId, cookie };
}

const post = (w: World, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url: `/workspaces/${w.workspaceId}${url}`, cookies: { rid: w.cookie }, payload });
const patch = (w: World, url: string, payload?: unknown) =>
  app.inject({ method: "PATCH", url: `/workspaces/${w.workspaceId}${url}`, cookies: { rid: w.cookie }, payload });
const del = (w: World, url: string) =>
  app.inject({ method: "DELETE", url: `/workspaces/${w.workspaceId}${url}`, cookies: { rid: w.cookie } });
const get = (w: World, url: string) =>
  app.inject({ method: "GET", url: `/workspaces/${w.workspaceId}${url}`, cookies: { rid: w.cookie } });

describe("workspace catalog (real Postgres)", () => {
  it("registers, lists, filters, patches, and deletes entries — tenant-isolated", async () => {
    const w = await seed();
    const other = await seed();

    // (1) register a site + a social account.
    const site = await post(w, "/catalog", {
      kind: "site",
      name: "ipop.ai",
      identifier: "https://ipop.ai",
      metadata: { env: "prod" },
    });
    expect(site.statusCode).toBe(201);
    expect(site.json()).toMatchObject({ kind: "site", name: "ipop.ai", status: "active", provenance: "manual" });
    expect(site.json().metadata).toEqual({ env: "prod" });

    const social = await post(w, "/catalog", { kind: "social_account", name: "@ipop", identifier: "@ipop" });
    expect(social.statusCode).toBe(201);

    // (2) list all + filter by kind.
    expect((await get(w, "/catalog")).json()).toHaveLength(2);
    const sites = (await get(w, "/catalog?kind=site")).json();
    expect(sites).toHaveLength(1);
    expect(sites[0].name).toBe("ipop.ai");

    // (3) the sibling tenant sees none of it (the #3 boundary).
    expect((await get(other, "/catalog")).json()).toHaveLength(0);

    // (4) patch the site's status.
    const patched = await patch(w, `/catalog/${site.json().id}`, { status: "inactive" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().status).toBe("inactive");

    // a sibling cannot patch w's entry (scoped to its own workspace → 404).
    expect((await patch(other, `/catalog/${site.json().id}`, { status: "archived" })).statusCode).toBe(404);

    // (5) delete the social account.
    expect((await del(w, `/catalog/${social.json().id}`)).statusCode).toBe(204);
    expect((await get(w, "/catalog")).json()).toHaveLength(1);
  });

  it("validates the body and rejects unknown kinds/statuses", async () => {
    const w = await seed();
    expect((await post(w, "/catalog", { name: "x" })).statusCode).toBe(400); // missing kind
    expect((await post(w, "/catalog", { kind: "site" })).statusCode).toBe(400); // missing name
    expect((await post(w, "/catalog", { kind: "nope", name: "x" })).statusCode).toBe(400);
    expect((await post(w, "/catalog", { kind: "site", name: "x", status: "weird" })).statusCode).toBe(400);
  });

  it("is dark when the catalog flag is OFF (403 on every route)", async () => {
    const w = await seed();
    delete process.env.RELOAD_CATALOG_ENABLED;
    try {
      expect((await get(w, "/catalog")).statusCode).toBe(403);
      expect((await post(w, "/catalog", { kind: "site", name: "x" })).statusCode).toBe(403);
    } finally {
      process.env.RELOAD_CATALOG_ENABLED = "true";
    }
  });
});
