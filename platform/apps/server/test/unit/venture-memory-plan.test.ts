import { describe, it, expect } from "vitest";
import { decideWeeklyPlan, type WeeklyPlanInput } from "../../src/venture-memory/plan.js";
import type { OkrDrift } from "../../src/venture-memory/okr.js";
import type { VentureMemoryEntry } from "../../src/venture-memory/types.js";

function drift(over: Partial<OkrDrift> = {}): OkrDrift {
  return {
    okrId: "okr_1",
    ideaId: "idea_1",
    objective: "Reach PMF",
    keyResults: [],
    drifting: false,
    verifiedCount: 0,
    totalCount: 0,
    ...over,
  };
}

function voice(text: string, id = "m_1"): VentureMemoryEntry {
  return { id, ideaId: "idea_1", kind: "customer_voice", text, why: null, sourceRef: null, createdAtMs: 0, stale: false };
}

function input(over: Partial<WeeklyPlanInput> = {}): WeeklyPlanInput {
  return {
    ideaId: "idea_1",
    weekKey: "2026-W24",
    verifiedMetricCount: 1,
    selfReportedScore: 72,
    okrDrift: [],
    memories: [],
    playbooks: [],
    openBacklogTitles: [],
    maxItems: 10,
    ...over,
  };
}

describe("decideWeeklyPlan: premortem #200 is structural, not prose", () => {
  it("labels EVERY item estimate UNVERIFIED (#200 mode 2)", () => {
    const draft = decideWeeklyPlan(
      input({ memories: [voice("users want CSV export")], playbooks: [{ id: "pb_1", category: "growth", pattern: "weekly digest" }] }),
    );
    expect(draft.items.length).toBeGreaterThan(0);
    expect(draft.items.every((i) => i.estimateLabel === "UNVERIFIED")).toBe(true);
  });

  it("GO only with an externally-verified metric receipt", () => {
    expect(decideWeeklyPlan(input({ verifiedMetricCount: 2 })).goNoGo).toBe("go");
  });

  it("NO-GO on zero verified metrics — a self-reported score never flips it", () => {
    const draft = decideWeeklyPlan(input({ verifiedMetricCount: 0, selfReportedScore: 99 }));
    expect(draft.goNoGo).toBe("no_go");
    expect(draft.rationale).toContain("#200");
    expect(draft.premortem.failureModes).toContain(2);
    expect(draft.premortem.failureModes).toContain(3);
  });

  it("always cites #200 and sets premortemCited", () => {
    const draft = decideWeeklyPlan(input());
    expect(draft.premortem.issue).toBe(200);
    expect(draft.premortemCited).toBe(true);
    expect(draft.rationale).toContain("#200");
  });
});

describe("decideWeeklyPlan: item generation + priority", () => {
  it("an unverified KR produces a top-priority 'instrument a verified metric' item", () => {
    const d = decideWeeklyPlan(
      input({
        okrDrift: [
          drift({
            keyResults: [
              { metric: "MRR", target: 1000, current: 500, unit: "usd", verified: false, source: null, progress: 0.5, status: "unverified" },
            ],
          }),
        ],
      }),
    );
    expect(d.items[0]!.title).toContain("Instrument a verified metric for MRR");
    expect(d.items[0]!.severityTier).toBe(3);
    expect(d.items[0]!.source).toBe("scorecard_gap");
  });

  it("a behind verified KR produces a close-the-gap item", () => {
    const d = decideWeeklyPlan(
      input({
        okrDrift: [
          drift({
            keyResults: [
              { metric: "signups", target: 100, current: 20, unit: "count", verified: true, source: "vr_9", progress: 0.2, status: "behind" },
            ],
          }),
        ],
      }),
    );
    expect(d.items.some((i) => i.title === "Close the OKR gap on signups")).toBe(true);
  });

  it("dedupes against the open backlog and respects maxItems", () => {
    const d = decideWeeklyPlan(
      input({
        memories: [voice("add CSV export", "m1"), voice("dark mode please", "m2"), voice("faster search", "m3")],
        openBacklogTitles: ["Address customer voice: add CSV export"],
        maxItems: 1,
      }),
    );
    expect(d.items.length).toBe(1);
    // the already-open CSV item is skipped; the first NEW item is taken
    expect(d.items[0]!.title).not.toContain("add CSV export");
  });

  it("offers candidate playbooks as apply items (cross-venture learning)", () => {
    const d = decideWeeklyPlan(input({ playbooks: [{ id: "pb_7", category: "launch", pattern: "ProductHunt launch on Tuesday" }] }));
    const pb = d.items.find((i) => i.source === "playbook");
    expect(pb).toBeDefined();
    expect(pb!.sourceRef).toBe("pb_7");
  });
});
