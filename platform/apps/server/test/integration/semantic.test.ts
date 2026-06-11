import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";

/**
 * #155 semantic layer — the metric catalog + canonical answers over the REAL default service (which reads
 * the governed summaries). Proves: the catalog is served, every answer cites a provenance path + freshness,
 * a governed metric resolves through `semantic_layer`, an unconfigured (venture-scoped) metric is a flagged
 * `raw_data` fallback, an unknown id is 404, and reads are tenant-scoped (the #19 IDOR boundary).
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

async function signup(): Promise<{ rid: string; wid: string }> {
  const slug = `sem-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  slugs.push(slug);
  const res = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `${slug}@example.com`, password: "hunter2hunter2", displayName: "Owner", workspaceSlug: slug },
  });
  expect(res.statusCode).toBe(201);
  const rid = res.cookies.find((c) => c.name === "rid")!.value;
  const me = await app.inject({ method: "GET", url: "/me", cookies: { rid } });
  return { rid, wid: me.json().workspaceId };
}

describe("semantic layer API (#155)", () => {
  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/workspaces/any/semantic/metrics" });
    expect(res.statusCode).toBe(401);
  });

  it("serves the catalog + an answer per metric, each citing provenance + freshness", async () => {
    const { rid, wid } = await signup();
    const res = await app.inject({ method: "GET", url: `/workspaces/${wid}/semantic/metrics`, cookies: { rid } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.catalog.some((m: { id: string }) => m.id === "growth.score")).toBe(true);
    expect(body.answers.length).toBe(body.catalog.length);
    for (const a of body.answers) {
      expect(a.spoken).toContain("made by robots, steered by humans.");
      expect(["semantic_layer", "curated_reference", "raw_data"]).toContain(a.path);
    }
  });

  it("answers a governed metric through the canonical semantic_layer path (one number)", async () => {
    const { rid, wid } = await signup();
    const res = await app.inject({ method: "GET", url: `/workspaces/${wid}/semantic/metrics/growth.score`, cookies: { rid } });
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.metricId).toBe("growth.score");
    expect(a.path).toBe("semantic_layer");
    expect(a.fallback).toBe(false);
    expect(a.value).toBe(0); // empty workspace ⇒ a governed 0, not a guess
    expect(a.spoken).toContain("semantic layer (canonical)");
  });

  it("flags a venture-scoped metric as a raw-data fallback at workspace scope", async () => {
    const { rid, wid } = await signup();
    const res = await app.inject({ method: "GET", url: `/workspaces/${wid}/semantic/metrics/venture.score`, cookies: { rid } });
    const a = res.json();
    expect(a.fallback).toBe(true);
    expect(a.path).toBe("raw_data");
    expect(a.spoken).toContain("No governed number");
  });

  it("404s an unknown metric id", async () => {
    const { rid, wid } = await signup();
    const res = await app.inject({ method: "GET", url: `/workspaces/${wid}/semantic/metrics/no.such`, cookies: { rid } });
    expect(res.statusCode).toBe(404);
  });

  it("is tenant-scoped — a sibling workspace cannot read another's metrics", async () => {
    const a = await signup();
    const b = await signup();
    const res = await app.inject({ method: "GET", url: `/workspaces/${a.wid}/semantic/metrics`, cookies: { rid: b.rid } });
    expect(res.statusCode).toBe(403);
  });
});
