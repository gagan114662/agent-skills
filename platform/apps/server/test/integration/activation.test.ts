import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { LocalRuntime } from "../../src/runtime/local.js";
import { SessionManager, type SessionLogger } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { dbStore, channelPoster } from "../../src/runtime/default.js";
import { createScale } from "../../src/scale/default.js";

/**
 * #221 — First-run activation produces a *running* venture (real Postgres + LocalRuntime).
 *
 * The dogfooded bug: clicking "Start your first venture" seeded departments but left
 * `venturePipeline.total = 0` and `mission-control.count = 0` — an empty desk that never runs — and a
 * rapid second click 429'd the founder into a dead end. These tests pin the fix end-to-end:
 *
 *   1. One seed → a venture in the pipeline (`venturePipeline.total ≥ 1`), FUNDED with an epic by the
 *      #230 activation kickoff (`funded ≥ 1`, not left sitting unevaluated in `active`), AND a live
 *      mission-control session (`count ≥ 1`): the on-screen "watch the board fill up" promise, kept.
 *   2. Re-seeding an already-activated workspace resumes the existing org — no duplicate venture, no
 *      relaunch — so it can never re-hit the admission cap (the idempotency that kills the 429 dead-end).
 *   3. A blocked activation (kill switch) still stands up the venture and returns 201 created-but-paused
 *      (#226/#227) — never a 429 dead-end — so the console renders the venture instead of an empty desk;
 *      a follow-up re-seed is then a no-op that launches nothing and likewise never 429s.
 *
 * The welcome harness sleeps briefly (no output) so the founding sessions stay live long enough to assert
 * mission-control sees them; caps stay generous so the seven launches never trip a concurrency limit.
 */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

// A welcome session that stays alive a few seconds (no output) — long enough to observe it live.
const SLEEP_HARNESS = ["-e", "setTimeout(() => {}, 4000);"];

let app: FastifyInstance;
const slugs: string[] = [];

beforeAll(async () => {
  // Generous caps (unlimited tenant/global concurrency) so the seven founding launches all admit on the
  // happy path; the kill-switch test forces the only denial we assert.
  const scale = createScale(0);
  const manager = new SessionManager({
    runtime: new LocalRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: process.execPath, args: SLEEP_HARNESS },
    caps: { wallClockMs: 30_000, idleMs: 25_000 },
    logger: silentLogger,
    admission: scale.admission,
    usage: scale.usage,
  });
  app = buildApp({ sessionManager: manager, scale });
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

async function newOwner(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `act-${newId()}`;
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

/** Hit the activation seam the way the first-run CTA does — `welcomeTasks: true`. */
async function activate(owner: { cookie: string; workspaceId: string }) {
  return app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/department/seed`,
    cookies: { rid: owner.cookie },
    payload: { welcomeTasks: true },
  });
}

async function founderConsole(owner: { cookie: string; workspaceId: string }) {
  return (
    await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/founder-console`,
      cookies: { rid: owner.cookie },
    })
  ).json() as { venturePipeline: { total: number; active: number; funded: number } };
}

async function missionControl(owner: { cookie: string; workspaceId: string }) {
  return (
    await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/mission-control`,
      cookies: { rid: owner.cookie },
    })
  ).json() as { sessions: unknown[]; count: number };
}

describe("#221 activation produces a running venture (real Postgres)", () => {
  it("one seed yields a venture in the pipeline AND a live mission-control session", async () => {
    const owner = await newOwner();

    const res = await activate(owner);
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      channels: unknown[];
      welcomeTasks: unknown[];
      venture?: { ideaId: string; created: boolean };
    };
    // The org is seeded, the first venture is stood up, and each lead opened its first task.
    expect(body.channels).toHaveLength(9);
    expect(body.venture?.created).toBe(true);
    expect(body.welcomeTasks.length).toBeGreaterThanOrEqual(1);

    // The pipeline is no longer an empty desk — total ≥ 1 (the founder-console roll-up the console reads).
    const fc = await founderConsole(owner);
    expect(fc.venturePipeline.total).toBeGreaterThanOrEqual(1);
    // #230: activation now drives the founding venture through the #96 loop and FUNDs it (epic + first
    // tasks), so its evaluation is terminal-FUND — it lands in the `funded` bucket, not `active`. Before
    // #230 the venture was created but never evaluated, so it sat in `active`; that inert row was the bug.
    expect(fc.venturePipeline.funded).toBeGreaterThanOrEqual(1);

    // A real session actually spawned — mission-control is non-empty (the "watch the board fill up" loop).
    const mc = await missionControl(owner);
    expect(mc.count).toBeGreaterThanOrEqual(1);
    expect(mc.sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("re-seeding an activated workspace resumes the same org — no duplicate venture, no relaunch", async () => {
    const owner = await newOwner();

    const first = (await activate(owner)).json() as {
      venture?: { ideaId: string; created: boolean };
      welcomeTasks: unknown[];
    };
    expect(first.venture?.created).toBe(true);
    expect(first.welcomeTasks.length).toBeGreaterThanOrEqual(1);

    // A second click returns 201 with the EXISTING venture (created:false) and launches NOTHING new — so
    // it can never re-hit the admission cap the way the old re-seed did.
    const again = await activate(owner);
    expect(again.statusCode).toBe(201);
    const second = again.json() as {
      channels: unknown[];
      venture?: { ideaId: string; created: boolean };
      welcomeTasks: unknown[];
    };
    expect(second.channels).toHaveLength(9);
    expect(second.venture?.created).toBe(false);
    expect(second.venture?.ideaId).toBe(first.venture?.ideaId);
    expect(second.welcomeTasks).toHaveLength(0);

    // The pipeline holds exactly one venture — re-activation never multiplied it.
    const fc = await founderConsole(owner);
    expect(fc.venturePipeline.total).toBe(1);
  });

  it("a kill-switched activation stands up the venture created-but-paused (201), never a 429 dead-end", async () => {
    const owner = await newOwner();
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/autonomy/kill`,
      cookies: { rid: owner.cookie },
    });

    // Every founding launch is denied by the kill switch — but the venture is a DB row, not a launch, so it
    // still stands up. The seed returns 201 with the venture created-but-paused (#226/#227), NOT a 429 the
    // founder can only re-fire into the wall.
    const res = await activate(owner);
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      venture?: { ideaId: string; created: boolean };
      welcomeTasks: unknown[];
    };
    expect(body.venture?.created).toBe(true);
    expect(body.welcomeTasks).toHaveLength(0); // launches were all denied — paused, not dead

    // The pipeline is non-empty (the console leaves the empty desk), and mission-control is honestly empty.
    const fc = await founderConsole(owner);
    expect(fc.venturePipeline.total).toBeGreaterThanOrEqual(1);
    const mc = await missionControl(owner);
    expect(mc.count).toBe(0);

    // #227: a follow-up re-seed of this already-activated (but paused) workspace launches nothing and
    // likewise returns 201 — it never re-hits the admission cap even with the kill switch still on.
    const again = await activate(owner);
    expect(again.statusCode).toBe(201);
    const second = again.json() as { venture?: { created: boolean }; welcomeTasks: unknown[] };
    expect(second.venture?.created).toBe(false);
    expect(second.welcomeTasks).toHaveLength(0);
    expect((await founderConsole(owner)).venturePipeline.total).toBe(1);
  });
});
