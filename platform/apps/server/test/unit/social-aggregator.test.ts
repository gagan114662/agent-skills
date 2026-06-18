import { describe, it, expect } from "vitest";
import {
  DryRunSocialAggregator,
  MockSocialAggregator,
  createSocialAggregator,
} from "../../src/social/aggregator.js";

/**
 * #269 — the connect-once aggregator bridge provider. The dry-run default makes NO network call and never
 * mints a real post (`live:false`, no external id/permalink) — an unwired deployment posts nothing real
 * (#200 §3). The mock double exercises the publish → verify (read-back) path with synthetic, non-secret ids.
 */

describe("DryRunSocialAggregator — posts nothing real", () => {
  it("is not live and returns no external id / permalink", async () => {
    const agg = new DryRunSocialAggregator();
    expect(agg.live).toBe(false);
    const out = await agg.publish({ workspaceId: "ws", body: "hi", networks: ["x", "linkedin"], scheduledAt: null });
    expect(out.aggregatorRef).toMatch(/^dryrun:/);
    for (const r of out.receipts) {
      expect(r.externalId).toBeNull();
      expect(r.permalink).toBeNull();
      expect(r.status).toBe("failed"); // immediate dry-run reached no network
    }
  });

  it("a scheduled dry-run is 'scheduled' (still nothing live)", async () => {
    const agg = new DryRunSocialAggregator();
    const out = await agg.publish({ workspaceId: "ws", body: "hi", networks: ["x"], scheduledAt: "2030-01-01T00:00:00Z" });
    expect(out.receipts[0]?.status).toBe("scheduled");
    expect(out.receipts[0]?.externalId).toBeNull();
  });

  it("verify resolves to nothing for a dry-run ref", async () => {
    const agg = new DryRunSocialAggregator();
    expect((await agg.verify({ workspaceId: "ws", aggregatorRef: "dryrun:x" })).receipts).toEqual([]);
  });
});

describe("MockSocialAggregator — exercises publish → read-back", () => {
  it("publishes per network with real-looking ids, and verify returns permalinks", async () => {
    const agg = new MockSocialAggregator();
    expect(agg.live).toBe(true);
    const out = await agg.publish({ workspaceId: "ws", body: "hi", networks: ["x", "linkedin"], scheduledAt: null });
    expect(out.aggregatorRef).toMatch(/^mock:/);
    expect(out.receipts.every((r) => r.status === "published" && r.externalId)).toBe(true);

    const verified = await agg.verify({ workspaceId: "ws", aggregatorRef: out.aggregatorRef! });
    const x = verified.receipts.find((r) => r.network === "x")!;
    expect(x.permalink).toMatch(/^https:\/\/mock\.social\.local\/x\//);
  });

  it("can simulate a per-network failure (partial success)", async () => {
    const agg = new MockSocialAggregator({ failNetworks: ["linkedin"] });
    const out = await agg.publish({ workspaceId: "ws", body: "hi", networks: ["x", "linkedin"], scheduledAt: null });
    expect(out.receipts.find((r) => r.network === "x")?.status).toBe("published");
    expect(out.receipts.find((r) => r.network === "linkedin")?.status).toBe("failed");
  });
});

describe("createSocialAggregator — dry-run unless a live client is wired", () => {
  it("returns the dry-run default with no client", () => {
    expect(createSocialAggregator({ client: null }).live).toBe(false);
    expect(createSocialAggregator({}).live).toBe(false);
  });

  it("returns a live provider when a client is supplied", async () => {
    const calls: string[] = [];
    const agg = createSocialAggregator({
      client: {
        async publish() {
          calls.push("publish");
          return { aggregatorRef: "live:1", receipts: [] };
        },
        async verify() {
          calls.push("verify");
          return { receipts: [] };
        },
      },
    });
    expect(agg.live).toBe(true);
    await agg.publish({ workspaceId: "ws", body: "x", networks: ["x"], scheduledAt: null });
    await agg.verify({ workspaceId: "ws", aggregatorRef: "live:1" });
    expect(calls).toEqual(["publish", "verify"]);
  });
});
