import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createRequest } from "../../src/db/repositories/approvals.js";
import { recordSessionStart, recordSessionCompute } from "../../src/db/repositories/tenant-usage.js";
import { dbBillingStore } from "../../src/db/repositories/billing.js";
import { windowKey, nextWindowKey, recentWindowKeys } from "../../src/scale/usage.js";

const app = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, cookies: { rid: cookie } });

async function seed(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `fc-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await get("/me", cookie)).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

describe("founder console route (integration, real Postgres)", () => {
  it("returns a quiet console for a fresh workspace — nothing pending, no attention", async () => {
    const { cookie, workspaceId } = await seed();

    const res = await get(`/workspaces/${workspaceId}/founder-console`, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.workspaceId).toBe(workspaceId);
    expect(typeof body.generatedAtMs).toBe("number");
    expect(body.fleet).toEqual({ activeSessions: 0, sessionsThisWindow: 0, globalInFlight: 0 });
    expect(body.venturePipeline).toEqual({ total: 0, active: 0, funded: 0, killed: 0, escalated: 0, scaffolds: 0 });
    expect(body.revenue.hasWillingnessToPay).toBe(false);
    expect(body.budget.overBudget).toBe(false);
    expect(body.pendingApprovals).toEqual([]);
    expect(body.switches.killSwitch).toBe(false);
    expect(body.attention).toEqual({ required: false, reasons: [] });

    // #253: the proof scorecard is wired end-to-end off the real repos. A fresh workspace has shipped
    // nothing yet, so the source-backed departments read 0 (still "connected" — a true zero), and the
    // unwired ones (Search Console SEO, the brand-asset store) report "not connected", never a fake number.
    expect(body.proofScorecard.total).toBe(8);
    const byDept: Record<string, { connection: string; value: number | null }> = Object.fromEntries(
      body.proofScorecard.tiles.map((t: { department: string; connection: string; value: number | null }) => [
        t.department,
        { connection: t.connection, value: t.value },
      ]),
    );
    expect(byDept.content).toEqual({ connection: "connected", value: 0 });
    expect(byDept.seo.connection).toBe("not_connected");
    expect(byDept.brand.connection).toBe("not_connected");
  });

  it("aggregates real usage, a pending #13 approval, and willingness-to-pay evidence", async () => {
    const { cookie, workspaceId, memberId } = await seed();
    const window = windowKey(new Date());

    // Real #71 tenant-usage rows for the current window.
    await recordSessionStart(workspaceId, window);
    await recordSessionStart(workspaceId, window);
    await recordSessionCompute(workspaceId, window, 120, 0);

    // A real #13 pending approval (an outbound-money action — the kind that binds to the human).
    await createRequest({
      workspaceId,
      requesterMemberId: memberId,
      actionType: "money.payout",
      payload: { to: "acct_1" },
      amount: 500,
      summary: "refund $5.00 to a customer",
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested" }],
    });

    // A real #98 willingness-to-pay evidence row (the strongest fundability signal).
    await dbBillingStore.createEvidence({
      workspaceId,
      sessionId: null,
      kind: "willingness_to_pay",
      source: "revenue",
      revenueEventId: null,
      amountCents: 2500,
      currency: "usd",
      summary: "customer paid $25.00",
    });

    const body = (await get(`/workspaces/${workspaceId}/founder-console`, cookie)).json();

    expect(body.budget.window).toBe(window);
    expect(body.budget.estimatedCostCents).toBe(0);
    expect(body.fleet.sessionsThisWindow).toBe(2);

    expect(body.revenue.willingnessToPayCount).toBe(1);
    expect(body.revenue.hasWillingnessToPay).toBe(true);

    expect(body.pendingApprovals).toHaveLength(1);
    expect(body.pendingApprovals[0]).toMatchObject({
      actionType: "money.payout",
      amount: 500,
      summary: "refund $5.00 to a customer",
    });
    expect(body.pendingApprovals[0].ageSeconds).toBeGreaterThanOrEqual(0);

    expect(body.attention.required).toBe(true);
    expect(body.attention.reasons).toContain("1 pending approval");
  });

  it("surfaces a cost forecast projected from the real tenant_usage trend (#113)", async () => {
    const { cookie, workspaceId } = await seed();
    const now = new Date();
    // Seed the last three windows with a rising cost trend: 1000 → 1500 → 2000 cents.
    const [w0, w1, w2] = recentWindowKeys(now, 3);
    await recordSessionCompute(workspaceId, w0!, 600, 1000);
    await recordSessionCompute(workspaceId, w1!, 900, 1500);
    await recordSessionCompute(workspaceId, w2!, 1200, 2000);

    const body = (await get(`/workspaces/${workspaceId}/founder-console`, cookie)).json();

    expect(body.costForecast.window).toBe(nextWindowKey(now));
    expect(body.costForecast.basis).toBe("trend");
    // last + average delta = 2000 + 500 = 2500
    expect(body.costForecast.projectedCostCents).toBe(2500);
    // No infra ceiling configured for a fresh tenant → never a projected breach.
    expect(body.costForecast.infraBudget.exceeded).toBe(false);
    expect(body.costForecast.rightSizing.recommendation).toBe("hold"); // no cap set → null utilization
  });

  it("is tenant-isolated: one workspace cannot read another's console (403)", async () => {
    const a = await seed();
    const b = await seed();

    const cross = await get(`/workspaces/${a.workspaceId}/founder-console`, b.cookie);
    expect(cross.statusCode).toBe(403);
  });

  it("rejects an unauthenticated caller (401)", async () => {
    const { workspaceId } = await seed();
    const res = await app.inject({ method: "GET", url: `/workspaces/${workspaceId}/founder-console` });
    expect(res.statusCode).toBe(401);
  });
});
