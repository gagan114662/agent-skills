import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import {
  workspaces,
  ventureEvaluations,
  ventureIdeas,
  approvalRequests,
  memories,
} from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

/**
 * Portfolio Lifecycle Loop (#107) end-to-end against real Postgres: review a LAUNCHED (funded) venture
 * with no growth/moat/demand → SUNSET; request the kill → a PENDING #13 `portfolio.sunset` request (no
 * teardown); execute is blocked until a human approves; once approved → the idea flips `killed` and the
 * post-mortem lands in the #15 memory graph. Exercises the real `portfolio_reviews` table, the FK to
 * `venture_ideas`, the approvals gate, and the memory write.
 */
const app = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

const post = (url: string, cookie: string, payload?: unknown) =>
  app.inject({ method: "POST", url, cookies: { rid: cookie }, payload: payload ?? {} });
const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, cookies: { rid: cookie } });

async function seed(): Promise<{ cookie: string; workspaceId: string }> {
  const slug = `portfolio-${newId()}`;
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

/** Mark a venture launched (funded), backdating the launch past the 14d grace window. */
async function launch(wid: string, ideaId: string, daysAgo: number): Promise<void> {
  const launchedAt = new Date(Date.now() - daysAgo * 86_400_000);
  await db
    .update(ventureEvaluations)
    .set({ status: "terminal", terminalVerdict: "FUND", updatedAt: launchedAt })
    .where(and(eq(ventureEvaluations.workspaceId, wid), eq(ventureEvaluations.ideaId, ideaId)));
}

describe("portfolio lifecycle loop (integration, real Postgres)", () => {
  it("reviews a launched venture with no traction as SUNSET and persists the snapshot", async () => {
    const { cookie, workspaceId } = await seed();
    const ideaId = await createIdea(cookie, workspaceId, "portfolio-dead");
    await launch(workspaceId, ideaId, 60);

    const res = await post(`/workspaces/${workspaceId}/portfolio/review`, cookie);
    expect(res.statusCode).toBe(201);
    const reviews = res.json().reviews;
    expect(reviews).toHaveLength(1);
    expect(reviews[0].ventureIdeaId).toBe(ideaId);
    expect(reviews[0].decision).toBe("SUNSET");
    expect(reviews[0].status).toBe("recorded");
    expect(reviews[0].ageInDays).toBeGreaterThanOrEqual(59);

    const dash = (await get(`/workspaces/${workspaceId}/portfolio`, cookie)).json();
    expect(dash.reviews).toHaveLength(1);
    expect(dash.reviews[0].decision).toBe("SUNSET");
  });

  it("does not review an un-launched (still-active) venture", async () => {
    const { cookie, workspaceId } = await seed();
    await createIdea(cookie, workspaceId, "portfolio-not-funded"); // left active (no FUND)
    const res = await post(`/workspaces/${workspaceId}/portfolio/review`, cookie);
    expect(res.statusCode).toBe(201);
    expect(res.json().reviews).toHaveLength(0);
  });

  it("executes the SUNSET autonomously (#243 money-only), killing + writing a post-mortem with no approval", async () => {
    const { cookie, workspaceId } = await seed();
    const ideaId = await createIdea(cookie, workspaceId, "portfolio-sunset");
    await launch(workspaceId, ideaId, 90);

    const reviewId = (await post(`/workspaces/${workspaceId}/portfolio/review`, cookie)).json()
      .reviews[0].id;

    // Under #243 a sunset (a kill) is not a money action → it runs autonomously: requesting it executes
    // it immediately (200, gated:false), with no parked owner approval. (A workspace can still opt a
    // portfolio.sunset rule back into a gate; the policy seam is unchanged.)
    const reqRes = await post(
      `/workspaces/${workspaceId}/portfolio/reviews/${reviewId}/sunset`,
      cookie,
    );
    expect(reqRes.statusCode).toBe(200);
    const { approvalRequestId, gated, review } = reqRes.json();
    expect(gated).toBe(false);
    expect(approvalRequestId).toBeNull();
    expect(review.status).toBe("sunset_executed");

    // No portfolio.sunset approval was ever parked.
    const parked = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.actionType, "portfolio.sunset"));
    expect(parked).toHaveLength(0);

    // The venture is killed and the lesson is written to memory — all without an owner prompt.
    const killedIdea = (
      await db.select().from(ventureIdeas).where(eq(ventureIdeas.id, ideaId))
    )[0];
    expect(killedIdea.status).toBe("killed");

    const memo = (
      await db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.workspaceId, workspaceId),
            eq(memories.dedupeKey, `portfolio:sunset:${ideaId}`),
          ),
        )
    )[0];
    expect(memo).toBeTruthy();
    expect((memo.content as { text: string }).text.toLowerCase()).toContain("sunset");
  });

  it("surfaces the portfolio pane on the Founder Console", async () => {
    const { cookie, workspaceId } = await seed();
    const ideaId = await createIdea(cookie, workspaceId, "portfolio-console");
    await launch(workspaceId, ideaId, 60);
    await post(`/workspaces/${workspaceId}/portfolio/review`, cookie);

    const console_ = (await get(`/workspaces/${workspaceId}/founder-console`, cookie)).json();
    expect(console_.portfolio.reviewed).toBe(1);
    expect(console_.portfolio.sunset).toBe(1);
    expect(console_.portfolio.sunsetsRecommended).toBe(1);
  });
});
