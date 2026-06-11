import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";

/**
 * #155 eval-gated maintenance API — running an agent's offline suite persists an `eval_runs` row and the
 * audit trail is tenant-scoped. The default service grades through the REAL semantic layer over the live
 * (empty) governed summaries, so the lens suite still passes 100% (its metric answers cite the canonical
 * `semantic_layer` path and are fresh even at value 0). Proves: run → persist → list, 404 unknown agent,
 * and the #19 tenant boundary on the run history.
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
  const slug = `evals-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

describe("eval-gated maintenance API (#155)", () => {
  it("requires authentication", async () => {
    const res = await app.inject({ method: "POST", url: "/workspaces/any/evals/lens/run" });
    expect(res.statusCode).toBe(401);
  });

  it("lists the fleet's eval domains", async () => {
    const { rid, wid } = await signup();
    const res = await app.inject({ method: "GET", url: `/workspaces/${wid}/evals`, cookies: { rid } });
    expect(res.statusCode).toBe(200);
    expect(res.json().agents).toEqual(expect.arrayContaining(["lens", "scout", "mark"]));
  });

  it("runs an agent's suite, persists a run row, and lists it", async () => {
    const { rid, wid } = await signup();
    const run = await app.inject({ method: "POST", url: `/workspaces/${wid}/evals/lens/run`, cookies: { rid } });
    expect(run.statusCode).toBe(201);
    const outcome = run.json();
    expect(outcome.summary.agent).toBe("lens");
    expect(outcome.summary.passRate).toBe(1); // real semantic-layer routing ⇒ lens holds 100%
    expect(outcome.verdict.regressed).toBe(false);
    expect(outcome.record.id).toBeTruthy();

    const list = await app.inject({ method: "GET", url: `/workspaces/${wid}/evals/runs`, cookies: { rid } });
    expect(list.statusCode).toBe(200);
    const runs = list.json().runs;
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatchObject({ agent: "lens", passRate: 1, regressed: false });
  });

  it("tolerates a repeated ?agent query param (array) without crashing", async () => {
    const { rid, wid } = await signup();
    await app.inject({ method: "POST", url: `/workspaces/${wid}/evals/lens/run`, cookies: { rid } });
    // A repeated param arrives as an array; the route must treat it as "no filter", not pass it to eq().
    const res = await app.inject({ method: "GET", url: `/workspaces/${wid}/evals/runs?agent=lens&agent=mark`, cookies: { rid } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().runs)).toBe(true);
  });

  it("404s an unknown agent", async () => {
    const { rid, wid } = await signup();
    const res = await app.inject({ method: "POST", url: `/workspaces/${wid}/evals/nope/run`, cookies: { rid } });
    expect(res.statusCode).toBe(404);
  });

  it("is tenant-scoped — a sibling cannot see another workspace's eval runs", async () => {
    const a = await signup();
    await app.inject({ method: "POST", url: `/workspaces/${a.wid}/evals/lens/run`, cookies: { rid: a.rid } });
    const b = await signup();
    const cross = await app.inject({ method: "GET", url: `/workspaces/${a.wid}/evals/runs`, cookies: { rid: b.rid } });
    expect(cross.statusCode).toBe(403);
    const own = await app.inject({ method: "GET", url: `/workspaces/${b.wid}/evals/runs`, cookies: { rid: b.rid } });
    expect(own.json().runs.length).toBe(0);
  });
});
