import { describe, it, expect } from "vitest";
import {
  revenueRewardByChannel,
  revenueRewardFromRollup,
  reweightClustersByRevenue,
  channelForCluster,
  type RankableCluster,
} from "../../src/attribution/reward.js";
import type { ArtifactRevenue, AttributedRevenueEvent } from "../../src/attribution/chain.js";

const event = (over: Partial<AttributedRevenueEvent> = {}): AttributedRevenueEvent => ({
  providerEventId: "evt",
  artifactId: "blog/launch",
  artifactKind: "seo_page",
  channel: "seo",
  trackingRef: "ipop_abc",
  amountCents: 4900,
  currency: "usd",
  exposureAtMs: 1_000,
  paidAtMs: 2_000,
  ...over,
});

const cluster = (key: string, representativeTask: string): RankableCluster => ({ key, representativeTask });

describe("attribution/reward — revenueRewardByChannel (the L1 learning signal)", () => {
  it("rolls receipted dollars up per channel and normalizes to a [0,1] weight, dollars descending", () => {
    const reward = revenueRewardByChannel([
      event({ channel: "seo", amountCents: 3000 }),
      event({ channel: "seo", amountCents: 1000 }),
      event({ channel: "email", amountCents: 6000 }),
    ]);
    expect(reward.isEmpty).toBe(false);
    expect(reward.totalCents).toBe(10_000);
    // email (6000) outranks seo (4000) — more revenue first.
    expect(reward.byChannel.map((c) => c.channel)).toEqual(["email", "seo"]);
    expect(reward.weightFor("email")).toBeCloseTo(0.6);
    expect(reward.weightFor("seo")).toBeCloseTo(0.4);
    expect(reward.weightFor("ads")).toBe(0); // unrewarded channel
  });

  it("ZERO RECEIPTS ⇒ an empty reward (no fabricated signal)", () => {
    const reward = revenueRewardByChannel([]);
    expect(reward.isEmpty).toBe(true);
    expect(reward.totalCents).toBe(0);
    expect(reward.byChannel).toEqual([]);
    expect(reward.weightFor("seo")).toBe(0);
  });

  it("never rewards non-positive / non-finite amounts (only receipted dollars earn)", () => {
    const reward = revenueRewardByChannel([
      event({ channel: "seo", amountCents: 0 }),
      event({ channel: "social", amountCents: -100 }),
      event({ channel: "ads", amountCents: Number.NaN }),
    ]);
    expect(reward.isEmpty).toBe(true);
    expect(reward.totalCents).toBe(0);
  });

  it("builds the same reward from the #386 per-artifact rollup", () => {
    const rollup: ArtifactRevenue[] = [
      { artifactId: "a", artifactKind: "seo_page", channel: "seo", attributedCents: 4000, currency: "usd", paymentCount: 2 },
      { artifactId: "b", artifactKind: "email", channel: "email", attributedCents: 6000, currency: "usd", paymentCount: 1 },
    ];
    const reward = revenueRewardFromRollup(rollup);
    expect(reward.totalCents).toBe(10_000);
    expect(reward.weightFor("email")).toBeCloseTo(0.6);
  });
});

describe("attribution/reward — channelForCluster", () => {
  it("maps a task to its revenue channel by keyword, null when none present", () => {
    expect(channelForCluster(cluster("k", "Audit the homepage for top SEO issues"))).toBe("seo");
    expect(channelForCluster(cluster("k", "Draft the weekly email newsletter"))).toBe("email");
    expect(channelForCluster(cluster("k", "Write a social post for launch"))).toBe("social");
    expect(channelForCluster(cluster("k", "Reconcile the monthly invoice"))).toBeNull();
  });
});

describe("attribution/reward — reweightClustersByRevenue (more of what earns)", () => {
  // Frequency order: seo first (most recurring), email second.
  const clusters = [
    cluster("seo", "Audit the homepage for SEO issues"),
    cluster("email", "Draft the weekly email newsletter"),
  ];

  it("REORDERS so the higher-revenue channel's cluster ranks first, overriding frequency", () => {
    // email earns far more than seo ⇒ email cluster should jump ahead despite lower frequency.
    const reward = revenueRewardByChannel([
      event({ channel: "seo", amountCents: 100 }),
      event({ channel: "email", amountCents: 9900 }),
    ]);
    const ranked = reweightClustersByRevenue(clusters, reward);
    expect(ranked.map((r) => r.cluster.key)).toEqual(["email", "seo"]);
    expect(ranked[0]!.channel).toBe("email");
    expect(ranked[0]!.revenueWeight).toBeCloseTo(0.99);
  });

  it("keeps frequency order when revenue is too small to overcome it", () => {
    // seo earns slightly more, but its frequency lead already keeps it on top.
    const reward = revenueRewardByChannel([
      event({ channel: "seo", amountCents: 6000 }),
      event({ channel: "email", amountCents: 4000 }),
    ]);
    const ranked = reweightClustersByRevenue(clusters, reward);
    expect(ranked.map((r) => r.cluster.key)).toEqual(["seo", "email"]);
  });

  it("ZERO RECEIPTS ⇒ NO REWEIGHT: input order is returned unchanged (the #390 dependency)", () => {
    const empty = revenueRewardByChannel([]);
    const ranked = reweightClustersByRevenue(clusters, empty);
    expect(ranked.map((r) => r.cluster.key)).toEqual(["seo", "email"]);
    expect(ranked.every((r) => r.revenueWeight === 0)).toBe(true);
  });

  it("strength 0 ⇒ no reweight (frequency only)", () => {
    const reward = revenueRewardByChannel([event({ channel: "email", amountCents: 9999 })]);
    const ranked = reweightClustersByRevenue(clusters, reward, { strength: 0 });
    expect(ranked.map((r) => r.cluster.key)).toEqual(["seo", "email"]);
  });

  it("an unmatched cluster earns no boost (revenueWeight 0), never penalized", () => {
    const withUnmatched = [...clusters, cluster("misc", "Reconcile the monthly invoice")];
    const reward = revenueRewardByChannel([event({ channel: "email", amountCents: 5000 })]);
    const ranked = reweightClustersByRevenue(withUnmatched, reward);
    const misc = ranked.find((r) => r.cluster.key === "misc")!;
    expect(misc.channel).toBeNull();
    expect(misc.revenueWeight).toBe(0);
  });
});
