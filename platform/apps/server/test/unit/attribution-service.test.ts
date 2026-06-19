import { describe, it, expect } from "vitest";
import {
  projectAttributedRevenue,
  recordLiveShipExposure,
  type AttributionRevenueReader,
  type AttributionRevenueReceipt,
  type AttributionServiceDeps,
} from "../../src/attribution/service.js";
import type { Exposure } from "../../src/attribution/chain.js";
import { mintTrackingRef } from "../../src/attribution/tracking.js";
import type {
  AttributionExposureStore,
  RecordExposureInput,
} from "../../src/attribution/store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** An in-memory exposure store, idempotent on (workspaceId, trackingRef) like the real unique constraint. */
function fakeStore(): AttributionExposureStore & { rows: RecordExposureInput[] } {
  const rows: RecordExposureInput[] = [];
  return {
    rows,
    recordExposure(input: RecordExposureInput): Promise<{ id: string }> {
      const existingIdx = rows.findIndex(
        (r) => r.workspaceId === input.workspaceId && r.trackingRef === input.trackingRef,
      );
      if (existingIdx >= 0) return Promise.resolve({ id: `exp-${existingIdx}` });
      rows.push(input);
      return Promise.resolve({ id: `exp-${rows.length - 1}` });
    },
    listExposures(workspaceId: string, sinceMs?: number): Promise<Exposure[]> {
      return Promise.resolve(
        rows
          .filter((r) => r.workspaceId === workspaceId && (sinceMs === undefined || r.occurredAtMs > sinceMs))
          .map((r) => ({
            artifactId: r.artifactId,
            artifactKind: r.artifactKind,
            trackingRef: r.trackingRef,
            channel: r.channel,
            occurredAtMs: r.occurredAtMs,
          })),
      );
    },
  };
}

/** An in-memory revenue reader returning canned verified receipts (the finance RevenueEventReader shape). */
function fakeRevenue(receipts: AttributionRevenueReceipt[]): AttributionRevenueReader {
  return {
    listReceipts: (_workspaceId: string) => Promise.resolve(receipts),
  };
}

function buildDeps(
  over: Partial<AttributionServiceDeps> = {},
  nowMs = 1_000_000,
): AttributionServiceDeps {
  return {
    store: over.store ?? fakeStore(),
    revenue: over.revenue ?? fakeRevenue([]),
    maxChainAgeMs: over.maxChainAgeMs ?? 90 * DAY_MS,
    now: over.now ?? (() => nowMs),
  };
}

describe("attribution service — recordLiveShipExposure (#386)", () => {
  it("mints the ref from the live externalRef and records the exposure at the clock instant", async () => {
    const store = fakeStore();
    const deps = buildDeps({ store }, 5_000);
    const ref = await recordLiveShipExposure(deps, {
      workspaceId: "ws1",
      externalRef: "https://ipop.ai/blog/x",
      channel: "seo",
      artifactKind: "site_pr",
    });
    expect(ref).toBe(
      mintTrackingRef({ workspaceId: "ws1", artifactId: "https://ipop.ai/blog/x", channel: "seo" }),
    );
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      workspaceId: "ws1",
      artifactId: "https://ipop.ai/blog/x",
      artifactKind: "site_pr",
      channel: "seo",
      trackingRef: ref,
      occurredAtMs: 5_000,
    });
  });

  it("is idempotent — re-shipping the same artifact records ONE exposure row", async () => {
    const store = fakeStore();
    const deps = buildDeps({ store });
    const input = {
      workspaceId: "ws1",
      externalRef: "https://ipop.ai/blog/x",
      channel: "seo",
      artifactKind: "site_pr",
    };
    const ref1 = await recordLiveShipExposure(deps, input);
    const ref2 = await recordLiveShipExposure(deps, input);
    expect(ref1).toBe(ref2);
    expect(store.rows).toHaveLength(1);
  });
});

describe("attribution service — projectAttributedRevenue (#386)", () => {
  it("receipts WITHOUT a tracking ref land in unattributed (slice-3 wires the ref through checkout)", async () => {
    const store = fakeStore();
    // An exposure exists, but receipts carry no ref yet — they cannot be credited and must NOT be fabricated.
    await store.recordExposure({
      workspaceId: "ws1",
      artifactId: "art-1",
      artifactKind: "site_pr",
      trackingRef: "ipop_deadbeefdeadbeef",
      channel: "seo",
      occurredAtMs: 1_000,
    });
    const receipts: AttributionRevenueReceipt[] = [
      { providerEventId: "evt_1", amountCents: 5000, currency: "usd", createdAtMs: 2_000 },
      { providerEventId: "evt_2", amountCents: 2500, currency: "usd", createdAtMs: 3_000 },
    ];
    const deps = buildDeps({ store, revenue: fakeRevenue(receipts) });
    const result = await projectAttributedRevenue(deps, "ws1");
    expect(result.attributed).toHaveLength(0);
    expect(result.unattributed).toHaveLength(2);
    expect(result.unattributed.map((r) => r.providerEventId).sort()).toEqual(["evt_1", "evt_2"]);
    expect(result.byArtifact).toHaveLength(0);
  });

  it("a seeded exposure + a ref-carrying receipt that happened-after it is attributed (proves the projection)", async () => {
    // Seed an exposure, then inject a receipt that DOES carry the ref via a custom reader+store that maps
    // it through (slice 3 will do this stamping in the real revenue reader). This proves the chain credits.
    const ref = mintTrackingRef({ workspaceId: "ws1", artifactId: "art-1", channel: "seo" });
    const store = fakeStore();
    await store.recordExposure({
      workspaceId: "ws1",
      artifactId: "art-1",
      artifactKind: "site_pr",
      trackingRef: ref,
      channel: "seo",
      occurredAtMs: 1_000,
    });

    // Custom service that bypasses the slice-2 null-ref mapping to prove the underlying causal credit works.
    const exposures = await store.listExposures("ws1");
    const { attributeRevenue, rollupByArtifact } = await import("../../src/attribution/chain.js");
    const credited = attributeRevenue(
      exposures,
      [
        {
          providerEventId: "evt_paid",
          trackingRef: ref,
          amountCents: 9900,
          currency: "usd",
          verified: true,
          occurredAtMs: 4_000,
        },
      ],
      { maxChainAgeMs: 90 * DAY_MS },
    );
    expect(credited.attributed).toHaveLength(1);
    expect(credited.attributed[0]).toMatchObject({
      providerEventId: "evt_paid",
      artifactId: "art-1",
      trackingRef: ref,
      amountCents: 9900,
    });
    const rollup = rollupByArtifact(credited.attributed);
    expect(rollup).toHaveLength(1);
    expect(rollup[0]).toMatchObject({ artifactId: "art-1", attributedCents: 9900, paymentCount: 1 });
  });
});
