import { describe, expect, it } from "vitest";
import { resolveGrowthCaps } from "../../src/growth/caps.js";
import { GrowthExperimentValidationError, GrowthService, type GrowthExperimentStore } from "../../src/growth/service.js";
import type { ExperimentStatus, GrowthExperimentRecord } from "../../src/growth/types.js";

const CLOCK = new Date("2026-06-23T13:00:00Z");

function experiment(over: Partial<GrowthExperimentRecord> = {}): GrowthExperimentRecord {
  return {
    id: "exp-1",
    workspaceId: "ws-1",
    ideaId: null,
    channel: "pricing",
    hypothesis: "A team-priced package lifts paid conversion.",
    variant: "team package",
    metricKey: "trial_to_paid",
    targetQuery: "",
    targetSource: "",
    status: "running",
    proposedByMemberId: "member-1",
    approvalRequestId: null,
    resultSummary: "",
    result: "",
    decision: "",
    createdAt: CLOCK,
    updatedAt: CLOCK,
    ...over,
  };
}

function makeStore(seed: GrowthExperimentRecord[] = []): GrowthExperimentStore {
  const rows = new Map(seed.map((row) => [row.id, row]));
  return {
    insert: async (input) => {
      const row = experiment({
        id: "exp-new",
        workspaceId: input.workspaceId,
        ideaId: input.ideaId,
        channel: input.channel,
        hypothesis: input.hypothesis,
        variant: input.variant,
        metricKey: input.metricKey,
        targetQuery: input.targetQuery,
        targetSource: input.targetSource,
        status: "proposed",
        proposedByMemberId: input.proposedByMemberId,
      });
      rows.set(row.id, row);
      return row;
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
    complete: async (workspaceId, id, result, decision, now) => {
      const row = rows.get(id);
      if (!row || row.workspaceId !== workspaceId) return undefined;
      const updated = {
        ...row,
        status: "completed" satisfies ExperimentStatus,
        resultSummary: result,
        result,
        decision,
        updatedAt: now,
      };
      rows.set(id, updated);
      return updated;
    },
  };
}

function makeService(store: GrowthExperimentStore) {
  return new GrowthService({
    events: {
      insert: async () => {
        throw new Error("not used");
      },
      list: async () => [],
    },
    experiments: store,
    gate: { submit: async () => ({ id: "approval-1" }) },
    caps: () => resolveGrowthCaps({ enabled: true }),
    now: () => CLOCK,
  });
}

describe("Growth experiment registry (#616)", () => {
  it("logs hypothesis, variant, and metric before an experiment runs", async () => {
    const service = makeService(makeStore());

    const rec = await service.proposeExperiment("ws-1", {
      channel: "pricing",
      hypothesis: "A team-priced package lifts paid conversion.",
      variant: "team package",
      metricKey: "trial_to_paid",
      targetSource: "producthunt",
      proposedByMemberId: "member-1",
    });

    expect(rec).toMatchObject({
      hypothesis: "A team-priced package lifts paid conversion.",
      variant: "team package",
      metricKey: "trial_to_paid",
      targetSource: "producthunt",
      result: "",
      decision: "",
      status: "proposed",
    });
  });

  it("records result and decision when the experiment completes", async () => {
    const service = makeService(makeStore([experiment()]));

    const completed = await service.completeExperiment("ws-1", "exp-1", {
      result: "Trial-to-paid moved from 4.0% to 6.1% over 240 trials.",
      decision: "Keep the team package and test annual anchoring next.",
    });

    expect(completed).toMatchObject({
      status: "completed",
      resultSummary: "Trial-to-paid moved from 4.0% to 6.1% over 240 trials.",
      result: "Trial-to-paid moved from 4.0% to 6.1% over 240 trials.",
      decision: "Keep the team package and test annual anchoring next.",
    });
  });

  it("refuses to complete without both result and decision", async () => {
    const service = makeService(makeStore([experiment()]));

    await expect(
      service.completeExperiment("ws-1", "exp-1", { result: "Lift was positive.", decision: "" }),
    ).rejects.toBeInstanceOf(GrowthExperimentValidationError);
  });
});
