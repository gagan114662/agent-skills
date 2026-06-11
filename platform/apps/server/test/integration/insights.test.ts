import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { InsightMiner, type Miner } from "../../src/insight/service.js";
import { insightRepo } from "../../src/insight/default.js";
import { INSIGHT_DEFAULTS, type InsightCaps } from "../../src/insight/caps.js";
import { createDefaultVentureService } from "../../src/venture/default.js";
import { upsertMemory, listMemories } from "../../src/db/repositories/memories.js";
import { getUsage, recordSessionCompute } from "../../src/db/repositories/tenant-usage.js";
import { windowKey } from "../../src/scale/usage.js";
import type { InsightInput } from "../../src/insight/types.js";

const NOW = new Date("2026-06-11T00:00:00Z");
const ventureService = createDefaultVentureService(() => NOW);

// A controllable miner: the test sets `nextInsights` before driving /mine.
let nextInsights: InsightInput[] = [];
const controllableMiner: Miner = { mine: async () => nextInsights };

// The real memory-graph killed-angle store (matches insight/default.ts) so dedupe is proven end-to-end.
const killedAngles = {
  listKilledKeys: async (workspaceId: string) => {
    const nodes = await listMemories(workspaceId, { type: "insight_kill" });
    return nodes
      .map((n) => (typeof n.content.angleKey === "string" ? n.content.angleKey : null))
      .filter((k): k is string => !!k);
  },
  recordKill: async (input: {
    workspaceId: string;
    dedupeKey: string;
    statement: string;
    reasoning: string;
    createdByMemberId: string | null;
  }) => {
    await upsertMemory({
      workspaceId: input.workspaceId,
      type: "insight_kill",
      content: { text: `Insight KILL: ${input.reasoning}`, angleKey: input.dedupeKey, statement: input.statement },
      entity: `insight:${input.dedupeKey}`,
      dedupeKey: `insight-kill:${input.dedupeKey}`,
      sourceType: "manual",
      sourceId: null,
      createdByMemberId: input.createdByMemberId,
    });
  },
};

const realUsage = {
  spentCents: async (wid: string, now: Date) => (await getUsage(wid, windowKey(now))).estimatedCostCents,
  charge: async (wid: string, cents: number, now: Date) => {
    if (cents > 0) await recordSessionCompute(wid, windowKey(now), 0, cents);
  },
};

let caps: InsightCaps = { ...INSIGHT_DEFAULTS, enabled: true, minSourceStrength: 0 };
const miner = new InsightMiner({
  repo: insightRepo,
  miner: controllableMiner,
  ventures: { submit: (w, i, m) => ventureService.submit(w, i, m) },
  killedAngles,
  caps: () => caps,
  usage: realUsage,
  scaleBudgetCents: () => 0,
  now: () => NOW,
});
const app = buildApp({ insight: miner });

// A second app with a real meter + low budget to prove the budget-exhaust → 402 route semantics.
const budgetedMiner = new InsightMiner({
  repo: insightRepo,
  miner: controllableMiner,
  ventures: { submit: (w, i, m) => ventureService.submit(w, i, m) },
  killedAngles,
  caps: () => ({ ...INSIGHT_DEFAULTS, enabled: true, minSourceStrength: 0, mineCostCents: 100 }),
  usage: realUsage,
  scaleBudgetCents: () => 100, // budget 100¢; pass 1 charges 100¢, pass 2's pre-check is at/over → 402
  now: () => NOW,
});
const budgetedApp = buildApp({ insight: budgetedMiner });

const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await budgetedApp.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

const post = (a: typeof app, url: string, cookie: string, payload?: unknown) =>
  a.inject({ method: "POST", url, cookies: { rid: cookie }, payload: payload as object });
const get = (a: typeof app, url: string, cookie: string) =>
  a.inject({ method: "GET", url, cookies: { rid: cookie } });

async function seed(a: typeof app): Promise<{ cookie: string; workspaceId: string }> {
  const slug = `in-${newId()}`;
  slugs.push(slug);
  const signup = await a.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await get(a, "/me", cookie)).json();
  return { cookie, workspaceId: me.workspaceId };
}

const SOURCE = {
  kind: "support_forum",
  url: "https://forum.example/t/flaky-cache",
  title: "CI caches corrupt silently",
  observedAt: NOW.toISOString(),
};

describe("insight miner routes (integration)", () => {
  it("ranks a source, mines it into a cited insight, and exposes its provenance", async () => {
    caps = { ...INSIGHT_DEFAULTS, enabled: true, minSourceStrength: 0 };
    const { cookie, workspaceId } = await seed(app);

    const added = await post(app, `/workspaces/${workspaceId}/insight-sources`, cookie, SOURCE);
    expect(added.statusCode).toBe(201);
    expect(added.json().evidenceStrength).toBeGreaterThan(0);

    const sources = await get(app, `/workspaces/${workspaceId}/insight-sources`, cookie);
    expect(sources.json()).toHaveLength(1);

    nextInsights = [
      {
        kind: "pain",
        statement: "CI caches corrupt silently and teams lose hours",
        painIntensity: 9,
        competitionAbsence: 8,
        freshnessAt: NOW,
        evidence: [{ sourceUrl: SOURCE.url, excerpt: "weekly", observedAt: NOW, sourceId: null }],
        sourceId: null,
      },
    ];
    const mined = await post(app, `/workspaces/${workspaceId}/insights/mine`, cookie);
    expect(mined.statusCode).toBe(200);
    expect(mined.json().skipped).toBeNull();
    expect(mined.json().insights).toHaveLength(1);

    const iid = mined.json().insights[0].id as string;
    const view = await get(app, `/workspaces/${workspaceId}/insights/${iid}`, cookie);
    expect(view.statusCode).toBe(200);
    expect(view.json().insight.score).toBeGreaterThan(0);
    expect(view.json().evidence[0].sourceUrl).toBe(SOURCE.url); // provenance carried
  });

  it("captures an owner secret as a first-class artifact and promotes it to a venture idea", async () => {
    const { cookie, workspaceId } = await seed(app);
    const captured = await post(app, `/workspaces/${workspaceId}/insights/owner-secret`, cookie, {
      statement: "Hospitals reuse fax to dodge HIPAA audits",
      painIntensity: 8,
      competitionAbsence: 9,
    });
    expect(captured.statusCode).toBe(201);
    expect(captured.json().kind).toBe("owner_secret");
    const iid = captured.json().id as string;

    const promoted = await post(app, `/workspaces/${workspaceId}/insights/${iid}/promote`, cookie, {
      targetUser: "clinic ops leads",
      wedge: "one regional clinic",
      marketPath: "$2B compliance",
    });
    expect(promoted.statusCode).toBe(201);
    expect(promoted.json().suppressed).toBe(false);
    const ideaId = promoted.json().ideaId as string;

    // The provenance link is persisted on the insight, and the venture idea really exists (FK-valid).
    const view = await get(app, `/workspaces/${workspaceId}/insights/${iid}`, cookie);
    expect(view.json().insight.promotedIdeaId).toBe(ideaId);
    expect(view.json().insight.status).toBe("promoted");
    const venture = await get(app, `/workspaces/${workspaceId}/ventures/${ideaId}`, cookie);
    expect(venture.statusCode).toBe(200);
    expect(venture.json().idea.insight).toBe("Hospitals reuse fax to dodge HIPAA audits");
  });

  it("a KILLed angle never returns uncited (memory-graph dedupe), but a cited one may", async () => {
    const { cookie, workspaceId } = await seed(app);
    const statement = "Rebuild the thing nobody asked for";

    // Capture + kill an uncited angle (records it to the #15 memory graph).
    const a = await post(app, `/workspaces/${workspaceId}/insights/owner-secret`, cookie, {
      statement,
      painIntensity: 5,
      competitionAbsence: 5,
    });
    await post(app, `/workspaces/${workspaceId}/insights/${a.json().id}/kill`, cookie, { reasoning: "not fundable" });

    // A NEW uncited insight repeating that angle is suppressed on promote (409).
    const b = await post(app, `/workspaces/${workspaceId}/insights/owner-secret`, cookie, {
      statement,
      painIntensity: 5,
      competitionAbsence: 5,
    });
    const suppressed = await post(app, `/workspaces/${workspaceId}/insights/${b.json().id}/promote`, cookie, {
      targetUser: "x",
      wedge: "y",
      marketPath: "z",
    });
    expect(suppressed.statusCode).toBe(409);
    expect(suppressed.json().suppressed).toBe(true);

    // The same angle WITH a real citation is allowed back (new evidence reopens it).
    const cited = await post(app, `/workspaces/${workspaceId}/insights/owner-secret`, cookie, {
      statement,
      painIntensity: 5,
      competitionAbsence: 5,
      evidence: [{ sourceUrl: "https://news.example/reg-change", excerpt: "regulation flipped", observedAt: NOW.toISOString() }],
    });
    const allowed = await post(app, `/workspaces/${workspaceId}/insights/${cited.json().id}/promote`, cookie, {
      targetUser: "x",
      wedge: "y",
      marketPath: "z",
    });
    expect(allowed.statusCode).toBe(201);
    expect(allowed.json().suppressed).toBe(false);
  });

  it("enforces tenant isolation: workspace B cannot read workspace A's insight", async () => {
    const a = await seed(app);
    const b = await seed(app);
    const captured = await post(app, `/workspaces/${a.workspaceId}/insights/owner-secret`, a.cookie, {
      statement: "tenant A secret",
      painIntensity: 5,
      competitionAbsence: 5,
    });
    const iid = captured.json().id as string;
    const cross = await get(app, `/workspaces/${a.workspaceId}/insights/${iid}`, b.cookie);
    expect(cross.statusCode).toBe(403); // assertWorkspace IDOR boundary
  });

  it("mining halts with 402 when the #71 tenant budget is exhausted", async () => {
    caps = { ...INSIGHT_DEFAULTS, enabled: true, minSourceStrength: 0 };
    const { cookie, workspaceId } = await seed(budgetedApp);
    await post(budgetedApp, `/workspaces/${workspaceId}/insight-sources`, cookie, SOURCE);
    nextInsights = [];

    const first = await post(budgetedApp, `/workspaces/${workspaceId}/insights/mine`, cookie);
    expect(first.statusCode).toBe(200); // charges 100¢ (pre-check 0 < 100 budget)
    const second = await post(budgetedApp, `/workspaces/${workspaceId}/insights/mine`, cookie);
    expect(second.statusCode).toBe(402); // 100¢ spent ≥ 100¢ budget → skipped 'budget'
    expect(second.json().skipped).toBe("budget");
  });
});
