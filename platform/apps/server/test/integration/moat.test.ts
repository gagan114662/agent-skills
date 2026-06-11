import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

/**
 * Moat Accrual (#103) end-to-end against real Postgres: record an accrual, read the venture's score +
 * stagnation, read the portfolio roll-up, and confirm the Founder Console (#104) surfaces each
 * venture's moat and flags the zero-accrual one. Exercises the real ledger table + the FK to
 * `venture_ideas`.
 */
const app = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

const post = (url: string, cookie: string, payload: unknown) =>
  app.inject({ method: "POST", url, cookies: { rid: cookie }, payload });
const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, cookies: { rid: cookie } });

async function seed(): Promise<{ cookie: string; workspaceId: string }> {
  const slug = `moat-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await get("/me", cookie)).json();
  return { cookie, workspaceId: me.workspaceId };
}

async function createIdea(cookie: string, wid: string, problem: string): Promise<string> {
  const res = await post(`/workspaces/${wid}/ventures`, cookie, {
    problem,
    targetUser: "devs",
    insight: "x",
    wedge: "y",
    marketPath: "z",
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

describe("moat accrual route (integration, real Postgres)", () => {
  it("records an accrual and scores the venture above zero, not stagnant", async () => {
    const { cookie, workspaceId } = await seed();
    const ideaId = await createIdea(cookie, workspaceId, "moat-alive");

    const rec = await post(`/workspaces/${workspaceId}/ventures/${ideaId}/moat`, cookie, {
      dimension: "proprietaryData",
      magnitude: 50,
      unit: "rows",
      description: "labeled outcomes",
      provenance: "pipeline:ingest",
    });
    expect(rec.statusCode).toBe(201);
    expect(rec.json().ventureIdeaId).toBe(ideaId);

    const moat = (await get(`/workspaces/${workspaceId}/ventures/${ideaId}/moat`, cookie)).json();
    expect(moat.score).toBeGreaterThan(0);
    expect(moat.dimensions.proprietaryData).toBeGreaterThan(0);
    expect(moat.stagnant).toBe(false);
    expect(moat.accrualsInWindow).toBe(1);
  });

  it("rejects an unknown dimension with 400", async () => {
    const { cookie, workspaceId } = await seed();
    const ideaId = await createIdea(cookie, workspaceId, "moat-bad");
    const res = await post(`/workspaces/${workspaceId}/ventures/${ideaId}/moat`, cookie, {
      dimension: "vibes",
      magnitude: 1,
      unit: "x",
      provenance: "p",
    });
    expect(res.statusCode).toBe(400);
  });

  it("flags a zero-accrual venture as stagnant in the portfolio + Founder Console", async () => {
    const { cookie, workspaceId } = await seed();
    const alive = await createIdea(cookie, workspaceId, "moat-portfolio-alive");
    const dormant = await createIdea(cookie, workspaceId, "moat-portfolio-dormant");
    await post(`/workspaces/${workspaceId}/ventures/${alive}/moat`, cookie, {
      dimension: "switchingCosts",
      magnitude: 30,
      unit: "workflows",
      provenance: "feature:automations",
    });

    const portfolio = (await get(`/workspaces/${workspaceId}/moat`, cookie)).json();
    expect(portfolio).toHaveLength(2);
    expect(portfolio.find((p: { ventureIdeaId: string }) => p.ventureIdeaId === alive).stagnant).toBe(
      false,
    );
    expect(
      portfolio.find((p: { ventureIdeaId: string }) => p.ventureIdeaId === dormant).stagnant,
    ).toBe(true);

    const console_ = (await get(`/workspaces/${workspaceId}/founder-console`, cookie)).json();
    expect(console_.moat.tracked).toBe(2);
    expect(console_.moat.flaggedStagnant).toBe(1);
    expect(console_.moat.flagged.map((m: { ventureIdeaId: string }) => m.ventureIdeaId)).toEqual([
      dormant,
    ]);
  });
});
