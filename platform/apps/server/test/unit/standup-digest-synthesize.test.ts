import { describe, it, expect } from "vitest";
import {
  synthesizeDailyDigest,
  buildAgentStandup,
  normalizeLink,
  ACTIVITY_WEIGHTS,
} from "../../src/standup-digest/synthesize.js";
import type { AgentActivityInput, DailyActivityData } from "../../src/standup-digest/types.js";

/**
 * Unit tests of the pure synthesis core (#589): link normalization, per-agent standup building, agent
 * ranking, totals, and the headline — all deterministic, no DB, no clock.
 */

const PERIOD = { day: "2026-06-22" };

function agent(over: Partial<AgentActivityInput> = {}): AgentActivityInput {
  return {
    agentId: "a1",
    agentName: "Agent One",
    artifacts: [],
    decisions: [],
    blockers: [],
    planned: [],
    ...over,
  };
}

function data(agents: AgentActivityInput[]): DailyActivityData {
  return { workspaceId: "ws-1", period: PERIOD, agents };
}

describe("normalizeLink", () => {
  it("accepts well-formed http(s) URLs", () => {
    expect(normalizeLink({ label: "PR", url: "https://github.com/x/y/pull/1" })).toEqual({
      label: "PR",
      url: "https://github.com/x/y/pull/1",
    });
  });

  it("accepts site-relative paths", () => {
    expect(normalizeLink({ label: "Receipt", url: "/workspaces/ws/receipts/1" })?.url).toBe(
      "/workspaces/ws/receipts/1",
    );
  });

  it("trims surrounding whitespace on label and url", () => {
    expect(normalizeLink({ label: "  PR  ", url: "  https://x.com/a  " })).toEqual({
      label: "PR",
      url: "https://x.com/a",
    });
  });

  it("drops malformed, empty, or protocol-relative URLs (no dead links)", () => {
    expect(normalizeLink(undefined)).toBeNull();
    expect(normalizeLink({ label: "x", url: "" })).toBeNull();
    expect(normalizeLink({ label: "", url: "https://x.com" })).toBeNull();
    expect(normalizeLink({ label: "x", url: "ftp://x.com/a" })).toBeNull();
    expect(normalizeLink({ label: "x", url: "javascript:alert(1)" })).toBeNull();
    expect(normalizeLink({ label: "x", url: "//evil.com" })).toBeNull();
    expect(normalizeLink({ label: "x", url: "not a url" })).toBeNull();
  });
});

describe("buildAgentStandup", () => {
  it("classifies a shipping agent and writes a what-they-did + what's-next summary", () => {
    const s = buildAgentStandup(
      agent({
        artifacts: [{ id: "art1", title: "Merged PR #762" }],
        planned: [{ id: "p1", summary: "Write the docs" }],
      }),
      5,
    );
    expect(s.status).toBe("shipping");
    expect(s.summary).toContain("shipped 1 (Merged PR #762)");
    expect(s.summary).toContain("Next: Write the docs");
  });

  it("classifies a blocked agent (no shipped/decided work, but has a blocker)", () => {
    const s = buildAgentStandup(agent({ blockers: [{ id: "b1", summary: "Waiting on API key" }] }), 5);
    expect(s.status).toBe("blocked");
    expect(s.summary).toContain("blocked on 1 (Waiting on API key)");
  });

  it("classifies planning and idle agents", () => {
    expect(buildAgentStandup(agent({ planned: [{ id: "p", summary: "x" }] }), 5).status).toBe("planning");
    const idle = buildAgentStandup(agent(), 5);
    expect(idle.status).toBe("idle");
    expect(idle.summary).toContain("no recorded activity");
    expect(idle.summary).toContain("Next: nothing planned");
  });

  it("computes counts and a weighted activity score", () => {
    const s = buildAgentStandup(
      agent({
        artifacts: [{ id: "a", title: "t" }],
        decisions: [{ id: "d", summary: "s" }],
        blockers: [{ id: "b", summary: "s" }],
        planned: [{ id: "p", summary: "s" }],
      }),
      5,
    );
    expect(s.shippedCount).toBe(1);
    expect(s.decisionCount).toBe(1);
    expect(s.blockerCount).toBe(1);
    expect(s.plannedCount).toBe(1);
    expect(s.activityScore).toBe(
      ACTIVITY_WEIGHTS.shipped + ACTIVITY_WEIGHTS.decision + ACTIVITY_WEIGHTS.blocker + ACTIVITY_WEIGHTS.planned,
    );
  });

  it("caps each section to maxItemsPerSection but keeps full counts", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, title: `t${i}` }));
    const s = buildAgentStandup(agent({ artifacts: many }), 3);
    expect(s.shipped).toHaveLength(3);
    expect(s.shippedCount).toBe(7);
  });

  it("orders blockers by severity (high first)", () => {
    const s = buildAgentStandup(
      agent({
        blockers: [
          { id: "b1", summary: "low one", severity: "low" },
          { id: "b2", summary: "high one", severity: "high" },
          { id: "b3", summary: "medium one", severity: "medium" },
        ],
      }),
      5,
    );
    expect(s.blockers.map((b) => b.severity)).toEqual(["high", "medium", "low"]);
  });

  it("collects working links across all entries (even beyond the cap) and dedupes", () => {
    const s = buildAgentStandup(
      agent({
        artifacts: [
          { id: "a1", title: "t1", receipt: { label: "R", url: "/r/1" } },
          { id: "a2", title: "t2", receipt: { label: "R", url: "/r/2" } },
          { id: "a3", title: "t3", receipt: { label: "R", url: "/r/1" } }, // dup url
          { id: "a4", title: "t4", receipt: { label: "R", url: "bad url" } }, // dropped
        ],
        decisions: [{ id: "d1", summary: "s", receipt: { label: "D", url: "/d/1" } }],
      }),
      1, // cap shows only 1 artifact, but links come from ALL entries
    );
    expect(s.shipped).toHaveLength(1);
    expect(s.links.map((l) => l.url)).toEqual(["/r/1", "/r/2", "/d/1"]);
  });

  it("strips a malformed link from a displayed entry rather than emitting it", () => {
    const s = buildAgentStandup(
      agent({ artifacts: [{ id: "a1", title: "t", receipt: { label: "R", url: "nope" } }] }),
      5,
    );
    expect(s.shipped[0]?.receipt).toBeUndefined();
  });
});

describe("synthesizeDailyDigest — ranking, totals, headline", () => {
  it("ranks agents needing attention (blockers) first, then by activity score", () => {
    const digest = synthesizeDailyDigest(
      data([
        agent({ agentId: "busy", agentName: "Busy", artifacts: [{ id: "a", title: "t" }, { id: "b", title: "u" }] }),
        agent({ agentId: "stuck", agentName: "Stuck", blockers: [{ id: "b", summary: "s" }] }),
        agent({ agentId: "idle", agentName: "Idle" }),
      ]),
    );
    expect(digest.agents.map((a) => a.agentId)).toEqual(["stuck", "busy", "idle"]);
  });

  it("breaks ties deterministically by name then id", () => {
    const digest = synthesizeDailyDigest(
      data([
        agent({ agentId: "z", agentName: "Zeta", planned: [{ id: "p", summary: "x" }] }),
        agent({ agentId: "a", agentName: "Alpha", planned: [{ id: "p", summary: "x" }] }),
      ]),
    );
    expect(digest.agents.map((a) => a.agentName)).toEqual(["Alpha", "Zeta"]);
  });

  it("rolls up team totals", () => {
    const digest = synthesizeDailyDigest(
      data([
        agent({ agentId: "x", artifacts: [{ id: "a", title: "t" }], blockers: [{ id: "b", summary: "s" }] }),
        agent({ agentId: "y", decisions: [{ id: "d", summary: "s" }], planned: [{ id: "p", summary: "s" }] }),
        agent({ agentId: "z" }), // idle
      ]),
    );
    expect(digest.totals).toEqual({
      agents: 3,
      activeAgents: 2,
      blockedAgents: 1,
      shipped: 1,
      decisions: 1,
      blockers: 1,
      planned: 1,
    });
  });

  it("builds a headline that summarizes activity and surfaces blockers", () => {
    const digest = synthesizeDailyDigest(
      data([agent({ artifacts: [{ id: "a", title: "t" }], blockers: [{ id: "b", summary: "s" }] })]),
    );
    expect(digest.headline).toContain("Daily standup for 2026-06-22");
    expect(digest.headline).toContain("1 shipped");
    expect(digest.headline).toContain("⚠️ 1 blocker");
  });

  it("says 'no blockers' in the headline when the team is unblocked", () => {
    const digest = synthesizeDailyDigest(data([agent({ artifacts: [{ id: "a", title: "t" }] })]));
    expect(digest.headline).toContain("no blockers");
  });

  it("aggregates and dedupes links across all agents", () => {
    const digest = synthesizeDailyDigest(
      data([
        agent({ agentId: "x", artifacts: [{ id: "a", title: "t", receipt: { label: "R", url: "/shared" } }] }),
        agent({ agentId: "y", decisions: [{ id: "d", summary: "s", receipt: { label: "R", url: "/shared" } }] }),
        agent({ agentId: "z", planned: [{ id: "p", summary: "s", receipt: { label: "T", url: "/unique" } }] }),
      ]),
    );
    expect(digest.links.map((l) => l.url).sort()).toEqual(["/shared", "/unique"]);
  });

  it("handles an empty roster", () => {
    const digest = synthesizeDailyDigest(data([]));
    expect(digest.agents).toHaveLength(0);
    expect(digest.totals.agents).toBe(0);
    expect(digest.links).toHaveLength(0);
  });
});
