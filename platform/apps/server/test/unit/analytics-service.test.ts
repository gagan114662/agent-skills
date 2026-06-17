import { describe, it, expect } from "vitest";
import { AnalyticsService } from "../../src/analytics/service.js";
import type { AnalyticsFlags, AnalyticsSiteContext } from "../../src/analytics/decide.js";
import type {
  AnalyticsInstall,
  AnalyticsInstallStore,
  AnalyticsProvider,
  AnalyticsReading,
} from "../../src/analytics/types.js";

/**
 * #270 — the service that auto-installs the tag and reads the metrics. It must: do NOTHING when the layer
 * is off (no write, no provider call), install idempotently, surface real provider numbers in the proof
 * tile, and fall back to the funnel reading (return null) when there is no real reading yet (no regression).
 */

const ON: AnalyticsFlags = { enabled: true, provider: "ga4", measurementId: "G-ABC123" };
const OFF: AnalyticsFlags = { enabled: false, provider: "dryrun", measurementId: "" };
const HOSTED: AnalyticsSiteContext = { hosted: true, externalSiteConnected: false };

function fakeStore(): AnalyticsInstallStore & { rows: Map<string, AnalyticsInstall>; writes: number } {
  const rows = new Map<string, AnalyticsInstall>();
  return {
    rows,
    writes: 0,
    async get(workspaceId) {
      return rows.get(workspaceId) ?? null;
    },
    async upsert(install) {
      this.writes++;
      rows.set(install.workspaceId, install);
    },
  };
}

const nullProvider: AnalyticsProvider = { id: "ga4", async readMetrics() { return null; } };
function readingProvider(reading: AnalyticsReading): AnalyticsProvider {
  return { id: "ga4", async readMetrics() { return reading; } };
}

describe("AnalyticsService (#270)", () => {
  it("does nothing when the layer is off — no install, no provider call", async () => {
    const installs = fakeStore();
    let providerCalls = 0;
    const provider: AnalyticsProvider = {
      id: "ga4",
      async readMetrics() {
        providerCalls++;
        return null;
      },
    };
    const svc = new AnalyticsService({
      flagsFor: () => OFF,
      siteContextFor: async () => HOSTED,
      provider,
      installs,
      now: () => 1000,
    });
    expect(await svc.ensureInstalled("ws-1")).toBeNull();
    expect(await svc.read("ws-1")).toBeNull();
    expect(await svc.tileReading("ws-1")).toBeNull();
    expect(installs.writes).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it("auto-installs the tag with the structural method and is idempotent", async () => {
    const installs = fakeStore();
    const svc = new AnalyticsService({
      flagsFor: () => ON,
      siteContextFor: async () => HOSTED,
      provider: nullProvider,
      installs,
      now: () => 1000,
    });
    const first = await svc.ensureInstalled("ws-1");
    expect(first?.method).toBe("hosted_auto_inject");
    expect(first?.provider).toBe("ga4");
    expect(installs.writes).toBe(1);
    // Re-installing with an unchanged snippet does not write again.
    await svc.ensureInstalled("ws-1");
    expect(installs.writes).toBe(1);
  });

  it("re-installs once when the snippet fingerprint changes (provider/id change)", async () => {
    const installs = fakeStore();
    let flags = ON;
    const svc = new AnalyticsService({
      flagsFor: () => flags,
      siteContextFor: async () => HOSTED,
      provider: nullProvider,
      installs,
      now: () => 1000,
    });
    await svc.ensureInstalled("ws-1");
    expect(installs.writes).toBe(1);
    flags = { ...ON, measurementId: "G-DIFFERENT" };
    await svc.ensureInstalled("ws-1");
    expect(installs.writes).toBe(2);
    // installedAt is preserved across re-install; updatedAt advances.
    expect(installs.rows.get("ws-1")?.installedAtMs).toBe(1000);
  });

  it("surfaces real provider numbers in the analytics proof tile", async () => {
    const reading: AnalyticsReading = {
      sessions: 412,
      signups: 18,
      conversions: 5,
      windowDays: 7,
      source: "ga4",
    };
    const svc = new AnalyticsService({
      flagsFor: () => ON,
      siteContextFor: async () => HOSTED,
      provider: readingProvider(reading),
      installs: fakeStore(),
      now: () => 1000,
    });
    const tile = await svc.tileReading("ws-1");
    expect(tile).not.toBeNull();
    expect(tile?.department).toBe("analytics");
    expect(tile?.connected).toBe(true);
    expect(tile?.current).toBe(5);
    expect(tile?.note).toContain("412 sessions");
    expect(tile?.note).toContain("18 signups");
    expect(tile?.source).toContain("#270");
  });

  it("returns null tile (funnel fallback) when on but not yet connected to a real reading", async () => {
    const svc = new AnalyticsService({
      flagsFor: () => ON,
      siteContextFor: async () => HOSTED,
      provider: nullProvider, // installed, but no reading yet
      installs: fakeStore(),
      now: () => 1000,
    });
    expect(await svc.tileReading("ws-1")).toBeNull();
    // The summary still reports the install so the owner sees the tag is live.
    const summary = await svc.summary("ws-1");
    expect(summary.enabled).toBe(true);
    expect(summary.install?.method).toBe("hosted_auto_inject");
    expect(summary.reading).toBeNull();
  });
});
