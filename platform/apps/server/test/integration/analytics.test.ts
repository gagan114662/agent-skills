import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, analyticsInstalls } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { dbAnalyticsInstallStore } from "../../src/db/repositories/analytics.js";
import { AnalyticsService } from "../../src/analytics/service.js";
import type { AnalyticsFlags, AnalyticsSiteContext } from "../../src/analytics/decide.js";
import type { AnalyticsProvider, AnalyticsReading } from "../../src/analytics/types.js";

/**
 * #270 — the analytics auto-install + read layer end-to-end on a real Postgres. Proves:
 *  - the `/me/analytics` route is reachable and, with the layer OFF (the default), reports nothing (no
 *    install written, no fabricated reading) — the funnel-only console behaviour is preserved;
 *  - the db-backed install store records ONE row per workspace and re-install is idempotent (the
 *    `(workspace_id)` unique index), with `installed_at` preserved across a re-install;
 *  - a connected read provider's real numbers surface in the analytics proof tile.
 */
const app = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

async function seed(): Promise<{ workspaceId: string; cookie: string }> {
  const slug = `an-${newId()}`;
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

const ON: AnalyticsFlags = { enabled: true, provider: "ga4", measurementId: "G-INT270" };
const HOSTED: AnalyticsSiteContext = { hosted: true, externalSiteConnected: false };
const nullProvider: AnalyticsProvider = { id: "ga4", async readMetrics() { return null; } };

describe("analytics auto-install + read (#270, real Postgres)", () => {
  it("GET /me/analytics reports nothing with the layer OFF (default) — no install written", async () => {
    const { workspaceId, cookie } = await seed();
    const res = await app.inject({ method: "GET", url: "/me/analytics", cookies: { rid: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, install: null, reading: null });
    // No row was written for a default-OFF workspace.
    const rows = await db
      .select()
      .from(analyticsInstalls)
      .where(eq(analyticsInstalls.workspaceId, workspaceId));
    expect(rows).toHaveLength(0);
  });

  it("db-backed install is idempotent (one row per workspace, installed_at preserved)", async () => {
    const { workspaceId } = await seed();
    let now = 1000;
    const svc = new AnalyticsService({
      flagsFor: () => ON,
      siteContextFor: async () => HOSTED,
      provider: nullProvider,
      installs: dbAnalyticsInstallStore,
      now: () => now,
    });

    const first = await svc.ensureInstalled(workspaceId);
    expect(first?.method).toBe("hosted_auto_inject");

    // Re-install with an unchanged snippet writes no new row and preserves installed_at.
    now = 5000;
    await svc.ensureInstalled(workspaceId);
    const rows = await db
      .select()
      .from(analyticsInstalls)
      .where(eq(analyticsInstalls.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.installedAt.getTime()).toBe(1000);
  });

  it("surfaces a connected provider's real numbers in the analytics proof tile", async () => {
    const { workspaceId } = await seed();
    const reading: AnalyticsReading = {
      sessions: 250,
      signups: 11,
      conversions: 4,
      windowDays: 7,
      source: "ga4",
    };
    const provider: AnalyticsProvider = { id: "ga4", async readMetrics() { return reading; } };
    const svc = new AnalyticsService({
      flagsFor: () => ON,
      siteContextFor: async () => HOSTED,
      provider,
      installs: dbAnalyticsInstallStore,
      now: () => 1000,
    });
    const tile = await svc.tileReading(workspaceId);
    expect(tile?.department).toBe("analytics");
    expect(tile?.connected).toBe(true);
    expect(tile?.current).toBe(4);
    expect(tile?.note).toContain("250 sessions");
  });
});
