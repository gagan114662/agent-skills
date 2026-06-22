import { describe, expect, it } from "vitest";
import {
  CostObservabilityService,
  resolveFallbackModel,
  type CostDeps,
} from "../../src/observability/cost/service.js";
import type { RunCostEventRow, RunCostRow } from "../../src/observability/cost/rollup.js";

const WS = "ws-1";

function run(partial: Partial<RunCostRow> & { id: string }): RunCostRow {
  return {
    agentMemberId: null,
    label: null,
    sessionId: null,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    startedAt: new Date("2026-06-20T10:00:00Z"),
    ...partial,
  };
}

/** In-memory fake of the cost persistence seam — exercises the service with no DB. */
function makeFakeDeps(
  rows: RunCostRow[],
  events: Record<string, RunCostEventRow[]> = {},
  workspaceId = WS,
): CostDeps {
  return {
    getRun: async (wid, runId) =>
      wid === workspaceId ? rows.find((r) => r.id === runId) : undefined,
    listRunEvents: async (wid, runId) => (wid === workspaceId ? (events[runId] ?? []) : []),
    listRunsInWindow: async (wid, window) => {
      if (wid !== workspaceId) return [];
      return rows.filter(
        (r) =>
          (!window.since || r.startedAt >= window.since) &&
          (!window.until || r.startedAt <= window.until),
      );
    },
  };
}

describe("CostObservabilityService.getRunCost", () => {
  it("returns per-run totals and a model breakdown", async () => {
    const svc = new CostObservabilityService(
      makeFakeDeps(
        [run({ id: "r1", agentMemberId: "alice", inputTokens: 1000, outputTokens: 1000, costMicros: 3000 })],
        {
          r1: [
            { type: "model_request", label: "claude-opus-4-8", inputTokens: 1000, outputTokens: null, costMicros: 2000 },
            { type: "model_response", label: "claude-opus-4-8", inputTokens: null, outputTokens: 1000, costMicros: 1000 },
          ],
        },
      ),
    );
    const cost = await svc.getRunCost(WS, "r1");
    expect(cost!.runId).toBe("r1");
    expect(cost!.totals.costMicros).toBe(3000); // recorded run cost wins
    expect(cost!.models).toHaveLength(1);
    expect(cost!.models[0]!.costMicros).toBe(3000);
  });

  it("returns undefined for an absent run", async () => {
    const svc = new CostObservabilityService(makeFakeDeps([]));
    expect(await svc.getRunCost(WS, "nope")).toBeUndefined();
  });

  it("is workspace-scoped: a foreign workspace cannot read the run", async () => {
    const svc = new CostObservabilityService(makeFakeDeps([run({ id: "r1", inputTokens: 100 })]));
    expect(await svc.getRunCost("ws-other", "r1")).toBeUndefined();
  });
});

describe("CostObservabilityService.getSummary", () => {
  it("rolls up totals, per-agent, and per-day across runs", async () => {
    const svc = new CostObservabilityService(
      makeFakeDeps([
        run({ id: "1", agentMemberId: "alice", costMicros: 1000, startedAt: new Date("2026-06-20T09:00:00Z") }),
        run({ id: "2", agentMemberId: "bob", costMicros: 5000, startedAt: new Date("2026-06-21T09:00:00Z") }),
        run({ id: "3", agentMemberId: "alice", costMicros: 2000, startedAt: new Date("2026-06-21T20:00:00Z") }),
      ]),
    );
    const summary = await svc.getSummary(WS);
    expect(summary.totals.runCount).toBe(3);
    expect(summary.totals.costMicros).toBe(8000);
    expect(summary.byAgent.map((a) => a.agentMemberId)).toEqual(["bob", "alice"]);
    expect(summary.byDay.map((d) => d.date)).toEqual(["2026-06-20", "2026-06-21"]);
    expect(summary.byDay[1]!.costMicros).toBe(7000);
  });

  it("filters by the time window and echoes it back", async () => {
    const svc = new CostObservabilityService(
      makeFakeDeps([
        run({ id: "old", costMicros: 100, startedAt: new Date("2026-06-01T00:00:00Z") }),
        run({ id: "new", costMicros: 200, startedAt: new Date("2026-06-21T00:00:00Z") }),
      ]),
    );
    const since = new Date("2026-06-15T00:00:00Z");
    const summary = await svc.getSummary(WS, { since });
    expect(summary.totals.runCount).toBe(1);
    expect(summary.totals.costMicros).toBe(200);
    expect(summary.window.since).toBe(since.toISOString());
    expect(summary.window.until).toBeNull();
  });

  it("estimates cost for runs whose cost was never recorded", async () => {
    const svc = new CostObservabilityService(
      makeFakeDeps([run({ id: "1", agentMemberId: "alice", inputTokens: 1000, outputTokens: 0, costMicros: 0 })]),
      {},
      WS,
    );
    const summary = await svc.getSummary(WS);
    expect(summary.totals.costMicros).toBe(5000); // 1000 input * $5/MTok via fallback model
    expect(summary.totals.estimatedRunCount).toBe(1);
    expect(summary.totals.recordedCostMicros).toBe(0);
  });

  it("honors an injected fallback model when estimating unrecorded cost", async () => {
    const opusSvc = new CostObservabilityService(
      makeFakeDeps([run({ id: "1", inputTokens: 1000, costMicros: 0 })]),
      "claude-opus-4-8",
    );
    const haikuSvc = new CostObservabilityService(
      makeFakeDeps([run({ id: "1", inputTokens: 1000, costMicros: 0 })]),
      "claude-haiku-4-5",
    );
    expect((await opusSvc.getSummary(WS)).totals.costMicros).toBe(5000); // 1000 * $5/MTok
    expect((await haikuSvc.getSummary(WS)).totals.costMicros).toBe(1000); // 1000 * $1/MTok
  });
});

describe("resolveFallbackModel", () => {
  it("defaults to the flagship and respects the env override", () => {
    const original = process.env.OBSERVABILITY_COST_DEFAULT_MODEL;
    try {
      delete process.env.OBSERVABILITY_COST_DEFAULT_MODEL;
      expect(resolveFallbackModel()).toBe("claude-opus-4-8");
      process.env.OBSERVABILITY_COST_DEFAULT_MODEL = "claude-haiku-4-5";
      expect(resolveFallbackModel()).toBe("claude-haiku-4-5");
    } finally {
      if (original === undefined) delete process.env.OBSERVABILITY_COST_DEFAULT_MODEL;
      else process.env.OBSERVABILITY_COST_DEFAULT_MODEL = original;
    }
  });
});
