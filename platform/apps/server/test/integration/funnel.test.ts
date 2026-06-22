import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

/**
 * #604 — full-funnel instrumentation end-to-end over the real `/me/analytics/funnel*` routes.
 * Proves the acceptance criteria through the actual HTTP surface:
 *  - the ONE ingest door accepts events from BOTH surfaces (`marketing` visit/signup, `product`
 *    activation/paid) under one consistent schema;
 *  - the ONE funnel view reports per-stage counts + stage-to-stage conversion rates;
 *  - the funnel is broken down by channel AND by agent;
 *  - a bad event is rejected (400) and the funnel is tenant-scoped (no cross-workspace bleed).
 */
const app = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

async function seed(): Promise<{ workspaceId: string; cookie: string }> {
  const slug = `fn-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { workspaceId: me.workspaceId, cookie };
}

async function track(cookie: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/me/analytics/funnel/track", cookies: { rid: cookie }, payload: body });
}

describe("full-funnel instrumentation (#604, real Postgres)", () => {
  it("requires identity", async () => {
    const res = await app.inject({ method: "GET", url: "/me/analytics/funnel" });
    expect(res.statusCode).toBe(401);
  });

  it("an empty workspace reports an all-zero funnel view", async () => {
    const { cookie } = await seed();
    const res = await app.inject({ method: "GET", url: "/me/analytics/funnel", cookies: { rid: cookie } });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.counts).toEqual({ visit: 0, signup: 0, activation: 0, paid: 0 });
    expect(view.byChannel).toEqual([]);
    expect(view.byAgent).toEqual([]);
  });

  it("records events from both surfaces and surfaces one funnel with rates + channel/agent breakdown", async () => {
    const { cookie } = await seed();

    // Marketing surface: visits + signups, attributed to channel + agent.
    for (let i = 0; i < 10; i++) await track(cookie, { stage: "visit", surface: "marketing", channel: "producthunt", agent: "mark" });
    for (let i = 0; i < 4; i++) await track(cookie, { stage: "visit", surface: "marketing", channel: "organic", agent: "scout" });
    for (let i = 0; i < 3; i++) await track(cookie, { stage: "signup", surface: "marketing", channel: "producthunt", agent: "mark" });
    await track(cookie, { stage: "signup", surface: "marketing", channel: "organic", agent: "scout" });
    // Product surface: activation + paid.
    for (let i = 0; i < 2; i++) await track(cookie, { stage: "activation", surface: "product", channel: "producthunt", agent: "mark" });
    const paid = await track(cookie, { stage: "paid", surface: "product", channel: "producthunt", agent: "mark", value: 1 });
    expect(paid.statusCode).toBe(201);
    expect(paid.json().event.stage).toBe("paid");

    const view = (await app.inject({ method: "GET", url: "/me/analytics/funnel", cookies: { rid: cookie } })).json();

    // Overall counts + conversion rates (visit 14 → signup 4 → activation 2 → paid 1).
    expect(view.counts).toEqual({ visit: 14, signup: 4, activation: 2, paid: 1 });
    expect(view.rates.signupRate).toBeCloseTo(4 / 14);
    expect(view.rates.activationRate).toBeCloseTo(0.5);
    expect(view.rates.paidRate).toBeCloseTo(0.5);
    expect(view.rates.overallRate).toBeCloseTo(1 / 14);

    // Broken down by channel — producthunt is the higher-traffic row, so it sorts first.
    expect(view.byChannel.map((r: { key: string }) => r.key)).toEqual(["producthunt", "organic"]);
    const ph = view.byChannel.find((r: { key: string }) => r.key === "producthunt");
    expect(ph.counts).toEqual({ visit: 10, signup: 3, activation: 2, paid: 1 });

    // Broken down by agent.
    const mark = view.byAgent.find((r: { key: string }) => r.key === "mark");
    expect(mark.counts).toEqual({ visit: 10, signup: 3, activation: 2, paid: 1 });
  });

  it("rejects an unknown stage with 400 and records nothing", async () => {
    const { cookie } = await seed();
    const bad = await track(cookie, { stage: "purchase" });
    expect(bad.statusCode).toBe(400);
    const view = (await app.inject({ method: "GET", url: "/me/analytics/funnel", cookies: { rid: cookie } })).json();
    expect(view.eventCount).toBe(0);
  });
});
