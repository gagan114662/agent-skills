import { describe, expect, it } from "vitest";
import {
  breakdownByModel,
  dayKeyUtc,
  enrichRunCost,
  rollupByAgent,
  rollupByDay,
  summarizeRunCost,
  summarizeRuns,
  type RunCostEventRow,
  type RunCostRow,
} from "../../src/observability/cost/rollup.js";

const FALLBACK = "claude-opus-4-8";

function run(partial: Partial<RunCostRow> & { id: string }): RunCostRow {
  return {
    agentMemberId: null,
    label: null,
    sessionId: null,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    startedAt: new Date("2026-06-20T12:00:00Z"),
    ...partial,
  };
}

describe("enrichRunCost", () => {
  it("uses recorded cost when present", () => {
    const e = enrichRunCost(run({ id: "r", inputTokens: 1000, costMicros: 999 }), FALLBACK);
    expect(e.effectiveCostMicros).toBe(999);
    expect(e.costEstimated).toBe(false);
  });

  it("estimates from tokens when cost is unrecorded", () => {
    const e = enrichRunCost(run({ id: "r", inputTokens: 1000, outputTokens: 0 }), FALLBACK);
    expect(e.effectiveCostMicros).toBe(5000); // 1000 input * $5/MTok
    expect(e.costEstimated).toBe(true);
  });

  it("does not mark a zero-token run as estimated", () => {
    const e = enrichRunCost(run({ id: "r" }), FALLBACK);
    expect(e.effectiveCostMicros).toBe(0);
    expect(e.costEstimated).toBe(false);
  });
});

describe("summarizeRuns", () => {
  it("sums tokens and separates recorded vs estimated cost", () => {
    const rows = [
      enrichRunCost(run({ id: "a", inputTokens: 100, outputTokens: 50, costMicros: 700 }), FALLBACK),
      enrichRunCost(run({ id: "b", inputTokens: 1000, outputTokens: 0 }), FALLBACK), // estimated 5000
    ];
    const t = summarizeRuns(rows);
    expect(t.runCount).toBe(2);
    expect(t.inputTokens).toBe(1100);
    expect(t.outputTokens).toBe(50);
    expect(t.totalTokens).toBe(1150);
    expect(t.costMicros).toBe(5700);
    expect(t.recordedCostMicros).toBe(700);
    expect(t.estimatedRunCount).toBe(1);
  });
});

describe("rollupByAgent", () => {
  it("groups by agent and sorts most-expensive first", () => {
    const rows = [
      enrichRunCost(run({ id: "1", agentMemberId: "alice", costMicros: 100 }), FALLBACK),
      enrichRunCost(run({ id: "2", agentMemberId: "bob", costMicros: 900 }), FALLBACK),
      enrichRunCost(run({ id: "3", agentMemberId: "alice", costMicros: 50 }), FALLBACK),
    ];
    const rollup = rollupByAgent(rows);
    expect(rollup.map((r) => r.agentMemberId)).toEqual(["bob", "alice"]);
    expect(rollup[0]!.costMicros).toBe(900);
    expect(rollup[1]!.runCount).toBe(2);
    expect(rollup[1]!.costMicros).toBe(150);
  });

  it("buckets unattributed runs under a null agent", () => {
    const rows = [enrichRunCost(run({ id: "1", agentMemberId: null, costMicros: 10 }), FALLBACK)];
    const rollup = rollupByAgent(rows);
    expect(rollup).toHaveLength(1);
    expect(rollup[0]!.agentMemberId).toBeNull();
  });
});

describe("rollupByDay", () => {
  it("groups by UTC day, oldest first", () => {
    const rows = [
      enrichRunCost(run({ id: "1", startedAt: new Date("2026-06-21T23:30:00Z"), costMicros: 10 }), FALLBACK),
      enrichRunCost(run({ id: "2", startedAt: new Date("2026-06-20T01:00:00Z"), costMicros: 20 }), FALLBACK),
      enrichRunCost(run({ id: "3", startedAt: new Date("2026-06-20T22:00:00Z"), costMicros: 30 }), FALLBACK),
    ];
    const rollup = rollupByDay(rows);
    expect(rollup.map((r) => r.date)).toEqual(["2026-06-20", "2026-06-21"]);
    expect(rollup[0]!.costMicros).toBe(50);
    expect(rollup[0]!.runCount).toBe(2);
    expect(rollup[1]!.costMicros).toBe(10);
  });

  it("dayKeyUtc returns a UTC calendar day", () => {
    expect(dayKeyUtc(new Date("2026-06-20T23:59:59Z"))).toBe("2026-06-20");
  });
});

describe("breakdownByModel", () => {
  const ev = (partial: Partial<RunCostEventRow>): RunCostEventRow => ({
    type: "model_response",
    label: "claude-opus-4-8",
    inputTokens: null,
    outputTokens: null,
    costMicros: null,
    ...partial,
  });

  it("groups model calls and prefers recorded cost", () => {
    const lines = breakdownByModel([
      ev({ type: "model_request", inputTokens: 1000, costMicros: 5000 }),
      ev({ type: "model_response", outputTokens: 200, costMicros: 5000 }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.model).toBe("claude-opus-4-8");
    expect(lines[0]!.callCount).toBe(2);
    expect(lines[0]!.inputTokens).toBe(1000);
    expect(lines[0]!.outputTokens).toBe(200);
    expect(lines[0]!.costMicros).toBe(10_000);
    expect(lines[0]!.costEstimated).toBe(false);
  });

  it("estimates cost for events lacking a recorded value and flags the line", () => {
    const lines = breakdownByModel([ev({ type: "model_response", outputTokens: 1000, costMicros: null })]);
    expect(lines[0]!.costMicros).toBe(25_000); // 1000 output * $25/MTok
    expect(lines[0]!.costEstimated).toBe(true);
  });

  it("ignores non-model events and empty-usage events", () => {
    const lines = breakdownByModel([
      ev({ type: "tool_call", label: "search", inputTokens: 5 }),
      ev({ type: "model_request", inputTokens: 0, outputTokens: 0, costMicros: 0 }),
    ]);
    expect(lines).toHaveLength(0);
  });

  it("separates distinct models, most expensive first", () => {
    const lines = breakdownByModel([
      ev({ label: "claude-haiku-4-5", outputTokens: 1000, costMicros: null }), // 5000
      ev({ label: "claude-opus-4-8", outputTokens: 1000, costMicros: null }), // 25000
    ]);
    expect(lines.map((l) => l.model)).toEqual(["claude-opus-4-8", "claude-haiku-4-5"]);
  });
});

describe("summarizeRunCost", () => {
  it("derives header cost from the model breakdown when the run has no recorded cost", () => {
    const summary = summarizeRunCost(
      run({ id: "r", agentMemberId: "alice", inputTokens: 1000, outputTokens: 1000 }),
      [
        { type: "model_request", label: "claude-opus-4-8", inputTokens: 1000, outputTokens: null, costMicros: null },
        { type: "model_response", label: "claude-opus-4-8", inputTokens: null, outputTokens: 1000, costMicros: null },
      ],
      FALLBACK,
    );
    expect(summary.runId).toBe("r");
    expect(summary.models).toHaveLength(1);
    // 1000 input ($5) + 1000 output ($25) = 5000 + 25000 micros
    expect(summary.totals.costMicros).toBe(30_000);
    expect(summary.totals.estimatedRunCount).toBe(1);
  });

  it("uses recorded run cost when present", () => {
    const summary = summarizeRunCost(run({ id: "r", inputTokens: 10, costMicros: 1234 }), [], FALLBACK);
    expect(summary.totals.costMicros).toBe(1234);
    expect(summary.totals.recordedCostMicros).toBe(1234);
    expect(summary.totals.estimatedRunCount).toBe(0);
  });

  it("falls back to a single-model estimate when there are no usable events", () => {
    const summary = summarizeRunCost(run({ id: "r", inputTokens: 1000 }), [], FALLBACK);
    expect(summary.totals.costMicros).toBe(5000);
    expect(summary.totals.estimatedRunCount).toBe(1);
    expect(summary.models).toHaveLength(0);
  });
});
