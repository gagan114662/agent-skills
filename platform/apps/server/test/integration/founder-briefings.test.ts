import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createRequest } from "../../src/db/repositories/approvals.js";
import {
  dbDeliveryStore,
  listBriefingDeliveries,
} from "../../src/db/repositories/founder-briefings.js";

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
  const slug = `fb-${newId()}`;
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

describe("founder briefings routes (integration, real Postgres)", () => {
  it("renders a quiet daily brief under the word budget for a fresh workspace", async () => {
    const { cookie, workspaceId } = await seed();
    const res = await get(`/workspaces/${workspaceId}/founder-briefings/daily`, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workspaceId).toBe(workspaceId);
    expect(body.wordCount).toBeLessThanOrEqual(200);
    expect(body.text).toContain("daily brief");
    expect(body.decisionsWaiting).toEqual([]);
  });

  it("renders the weekly founder report", async () => {
    const { cookie, workspaceId } = await seed();
    const res = await get(`/workspaces/${workspaceId}/founder-briefings/weekly`, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ventures).toEqual([]);
    expect(body.recommendations).toEqual({ doubleDown: 0, maintain: 0, pivot: 0, sunset: 0 });
    expect(body.text).toContain("weekly founder report");
  });

  it("surfaces a pending #13 approval in the decision queue (with a one-tap link + age)", async () => {
    const { cookie, workspaceId, memberId } = await seed();
    await createRequest({
      workspaceId,
      requesterMemberId: memberId, // real member id — the FK gotcha
      actionType: "refund.issue",
      payload: {},
      amount: 5000,
      summary: "Issue a $50 refund",
      status: "pending",
      expiresAt: null,
      events: [],
    });

    const res = await get(`/workspaces/${workspaceId}/founder-briefings/decision-queue`, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    const item = body.items[0];
    expect(item.kind).toBe("approval");
    expect(item.impact).toBe("high"); // amount > 0
    expect(item.title).toBe("Issue a $50 refund");
    expect(item.link).toContain(`/workspaces/${workspaceId}/approvals/`);
    expect(item.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it("is tenant-scoped: a caller cannot read another workspace's briefings", async () => {
    const a = await seed();
    const b = await seed();
    const res = await get(`/workspaces/${b.workspaceId}/founder-briefings/daily`, a.cookie);
    expect(res.statusCode).toBe(403);
  });

  it("delivery audit is idempotent on (workspace, kind, period) — the watermark", async () => {
    const { workspaceId } = await seed();
    const channels = [{ channel: "email" as const, delivered: true, reason: "delivered" }];

    expect(await dbDeliveryStore.wasDelivered(workspaceId, "daily", "2026-06-12")).toBe(false);
    await dbDeliveryStore.record({ workspaceId, kind: "daily", periodKey: "2026-06-12", delivered: true, channels, wordCount: 42 });
    expect(await dbDeliveryStore.wasDelivered(workspaceId, "daily", "2026-06-12")).toBe(true);

    // A repeat record for the same period is a no-op (the unique watermark).
    await dbDeliveryStore.record({ workspaceId, kind: "daily", periodKey: "2026-06-12", delivered: true, channels, wordCount: 99 });
    // A different period (and a different kind) inserts a new row.
    await dbDeliveryStore.record({ workspaceId, kind: "daily", periodKey: "2026-06-13", delivered: false, channels: [], wordCount: 0 });
    await dbDeliveryStore.record({ workspaceId, kind: "weekly", periodKey: "2026-W24", delivered: true, channels, wordCount: 80 });

    const rows = await listBriefingDeliveries(workspaceId);
    expect(rows).toHaveLength(3);
    const daily12 = rows.find((r) => r.kind === "daily" && r.periodKey === "2026-06-12")!;
    expect(daily12.wordCount).toBe(42); // the first write won; the duplicate was dropped
    expect(daily12.channels[0]!.channel).toBe("email");
  });

  it("exposes the delivery audit through the route", async () => {
    const { cookie, workspaceId } = await seed();
    await dbDeliveryStore.record({
      workspaceId,
      kind: "weekly",
      periodKey: "2026-W23",
      delivered: true,
      channels: [{ channel: "email", delivered: true, reason: "delivered" }],
      wordCount: 70,
    });
    const res = await get(`/workspaces/${workspaceId}/founder-briefings/deliveries`, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0].kind).toBe("weekly");
    expect(body.deliveries[0].periodKey).toBe("2026-W23");
  });
});
