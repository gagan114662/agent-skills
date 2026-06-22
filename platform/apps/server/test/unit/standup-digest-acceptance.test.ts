import { describe, it, expect } from "vitest";
import { StandupDigestService } from "../../src/standup-digest/service.js";
import { InMemoryStandupDigestStore } from "../../src/standup-digest/store.js";
import { FakeDailyActivitySource } from "../../src/standup-digest/source.js";
import { renderDigest, normalizeLink } from "../../src/standup-digest/index.js";
import type { StandupDigestCaps } from "../../src/standup-digest/caps.js";

/**
 * Acceptance test for issue #589:
 *   "A single daily digest summarizes all agent activity with working links; no need to read raw logs."
 *
 * End-to-end through the service over the deterministic, offline {@link FakeDailyActivitySource} (no external
 * calls, no DB) — exercising the same path a scheduler would. Asserts the digest is grouped by agent, carries
 * what-they-did + what's-next, surfaces blockers, has working links, and is deterministic/reproducible.
 */

const ENABLED: StandupDigestCaps = { enabled: true, maxItemsPerSection: 5 };

function makeService(clockMs = Date.UTC(2026, 5, 22, 12)) {
  return new StandupDigestService({
    store: new InMemoryStandupDigestStore(),
    dataSource: new FakeDailyActivitySource(),
    caps: ENABLED,
    now: () => new Date(clockMs),
  });
}

describe("#589 acceptance — daily agent standup digest", () => {
  it("produces a coherent digest grouped by agent with NO external calls (offline fake source)", async () => {
    const rec = await makeService().runScheduledDigest("acme");
    expect(rec).not.toBeNull();
    const digest = rec!.digest;

    // Grouped by agent: one section per fleet role, each with a status and a what-they-did + what's-next line.
    expect(digest.headline).toMatch(/^Daily standup for \d{4}-\d{2}-\d{2}:/);
    expect(digest.agents.length).toBeGreaterThan(0);
    for (const a of digest.agents) {
      expect(["shipping", "blocked", "planning", "idle"]).toContain(a.status);
      expect(a.summary.length).toBeGreaterThan(0);
      expect(a.summary).toContain("Next:"); // what's next is always present
    }
  });

  it("summarizes ALL agent activity in one digest — no need to read raw logs", async () => {
    const digest = (await makeService().runScheduledDigest("acme"))!.digest;
    // Totals account for every agent and every entry type.
    expect(digest.totals.agents).toBe(digest.agents.length);
    const shippedFromAgents = digest.agents.reduce((n, a) => n + a.shippedCount, 0);
    expect(digest.totals.shipped).toBe(shippedFromAgents);
    // The fake roster always has blockers → they are surfaced ("where it's stuck"), even on agents that
    // also shipped (a shipping agent with a blocker still surfaces the blocker via its count + ranking).
    expect(digest.totals.blockers).toBeGreaterThan(0);
    expect(digest.totals.blockedAgents).toBeGreaterThan(0);
    expect(digest.agents.some((a) => a.blockerCount > 0)).toBe(true);
  });

  it("every link is a working link (well-formed, deduped)", async () => {
    const digest = (await makeService().runScheduledDigest("acme"))!.digest;
    expect(digest.links.length).toBeGreaterThan(0);
    const urls = new Set<string>();
    for (const link of digest.links) {
      // Each survived normalization, so it round-trips unchanged.
      expect(normalizeLink(link)).toEqual(link);
      expect(urls.has(link.url)).toBe(false); // deduped
      urls.add(link.url);
    }
  });

  it("surfaces the agents that need attention (blockers) first", async () => {
    const digest = (await makeService().runScheduledDigest("acme"))!.digest;
    const firstUnblocked = digest.agents.findIndex((a) => a.blockerCount === 0);
    const lastBlocked = digest.agents.map((a) => a.blockerCount > 0).lastIndexOf(true);
    // Every blocked agent appears before every unblocked one.
    if (firstUnblocked !== -1 && lastBlocked !== -1) {
      expect(lastBlocked).toBeLessThan(firstUnblocked);
    }
  });

  it("renders to human-readable lines that include links", async () => {
    const digest = (await makeService().runScheduledDigest("acme"))!.digest;
    const lines = renderDigest(digest);
    const text = lines.join("\n");
    expect(lines[0]).toBe(digest.headline);
    expect(text).toContain("Next:");
    // A receipt link is rendered beside at least one entry.
    expect(text).toMatch(/\[[^\]]+: \/workspaces\//);
  });

  it("is deterministic: the same workspace-day reproduces an identical digest", async () => {
    const a = (await makeService().runScheduledDigest("acme"))!.digest;
    const b = (await makeService().runScheduledDigest("acme"))!.digest;
    expect(b).toEqual(a);
  });

  it("different workspaces get different digests (seed includes the workspace id)", async () => {
    const a = (await makeService().runScheduledDigest("acme"))!.digest;
    const b = (await makeService().runScheduledDigest("globex"))!.digest;
    // Links are workspace-scoped paths, so they differ.
    expect(a.links).not.toEqual(b.links);
  });
});
