import { describe, expect, it } from "vitest";
import { resolveGrowthCaps } from "../../src/growth/caps.js";
import { GrowthService, type GrowthExperimentStore } from "../../src/growth/service.js";
import type {
  ExperimentStatus,
  GrowthEventRecord,
  GrowthExperimentRecord,
} from "../../src/growth/types.js";

const CLOCK = new Date("2026-06-23T12:00:00Z");

function event(over: Partial<GrowthEventRecord> = {}): GrowthEventRecord {
  return {
    id: `evt-${Math.random()}`,
    workspaceId: "ws-1",
    ideaId: null,
    kind: "acquisition",
    source: "paid-search",
    value: 1,
    metadata: { experimentId: "exp-1" },
    occurredAt: CLOCK,
    createdAt: CLOCK,
    ...over,
  };
}

function experiment(over: Partial<GrowthExperimentRecord> = {}): GrowthExperimentRecord {
  return {
    id: "exp-1",
    workspaceId: "ws-1",
    ideaId: null,
    channel: "paid-search",
    hypothesis: "Paid search can acquire trial users profitably.",
    targetQuery: "",
    status: "running",
    proposedByMemberId: "member-1",
    approvalRequestId: null,
    resultSummary: "",
    createdAt: CLOCK,
    updatedAt: CLOCK,
    ...over,
  };
}

function makeStore(seed: GrowthExperimentRecord[]): GrowthExperimentStore {
  const rows = new Map(seed.map((row) => [row.id, row]));
  return {
    insert: async () => {
      throw new Error("not used");
    },
    get: async (_workspaceId, id) => rows.get(id),
    list: async (workspaceId) => [...rows.values()].filter((row) => row.workspaceId === workspaceId),
    linkApproval: async () => {
      throw new Error("not used");
    },
    updateStatus: async (workspaceId, id, status, resultSummary, now) => {
      const row = rows.get(id);
      if (!row || row.workspaceId !== workspaceId) return undefined;
      const updated = { ...row, status, resultSummary, updatedAt: now };
      rows.set(id, updated);
      return updated;
    },
  };
}

function makeService(events: GrowthEventRecord[], experiments: GrowthExperimentRecord[]) {
  const service = new GrowthService({
    events: {
      insert: async (input) =>
        event({
          ...input,
          id: "inserted",
          createdAt: CLOCK,
          metadata: input.metadata,
          source: input.source,
          value: input.value,
        }),
      list: async (workspaceId, ideaId) =>
        events.filter(
          (row) =>
            row.workspaceId === workspaceId &&
            (ideaId === undefined ? true : row.ideaId === ideaId),
        ),
    },
    experiments: makeStore(experiments),
    gate: {
      submit: async () => ({ id: "approval-1" }),
    },
    caps: () =>
      resolveGrowthCaps({
        enabled: true,
        minTrafficForScore: 0,
        autoPauseMinAcquisitions: 100,
        autoPauseMaxConversionRate: 0.02,
      }),
    now: () => CLOCK,
  });
  return service;
}

describe("GrowthService auto-pauses underperforming campaigns (#617)", () => {
  it("does not pause a running campaign before the fair-sample floor", async () => {
    const service = makeService(
      [
        event({ kind: "acquisition", value: 99 }),
        event({ kind: "conversion", value: 0 }),
      ],
      [experiment()],
    );

    expect(await service.autoPauseUnderperformers("ws-1")).toEqual([]);
  });

  it("pauses a running campaign after sufficient bad data and returns the user-facing reason", async () => {
    const service = makeService(
      [
        event({ kind: "acquisition", value: 150 }),
        event({ kind: "conversion", value: 1 }),
      ],
      [experiment()],
    );

    const [decision] = await service.autoPauseUnderperformers("ws-1");

    expect(decision?.experiment.status satisfies ExperimentStatus).toBe("paused");
    expect(decision?.reason).toContain("1 conversion from 150 acquisitions");
    expect(decision?.reason).toContain("0.7%");
    expect(decision?.reason).toContain("below the 2.0% threshold");
  });

  it("only evaluates events attributed to the same campaign/content id", async () => {
    const service = makeService(
      [
        event({ kind: "acquisition", value: 150, metadata: { experimentId: "exp-1" } }),
        event({ kind: "conversion", value: 10, metadata: { experimentId: "other-exp" } }),
      ],
      [experiment()],
    );

    const [decision] = await service.autoPauseUnderperformers("ws-1");

    expect(decision?.experiment.status).toBe("paused");
    expect(decision?.reason).toContain("0 conversions from 150 acquisitions");
  });
});
