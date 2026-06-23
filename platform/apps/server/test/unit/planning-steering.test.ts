import { describe, expect, it } from "vitest";
import { rankBacklog } from "../../src/planning/rice.js";
import { PlanningService, type BacklogStore, type SpecStore } from "../../src/planning/service.js";
import { parseSteeringIntent } from "../../src/planning/steering.js";
import type { BacklogItemRecord, PlanningSpecRecord } from "../../src/planning/types.js";

const NOW = new Date("2026-06-23T00:00:00Z");
const WS = "ws-1";

function item(over: Partial<BacklogItemRecord>): BacklogItemRecord {
  return {
    id: "i1",
    workspaceId: WS,
    ideaId: null,
    title: "generic work",
    description: "",
    source: "manual",
    sourceRef: "",
    reach: 10,
    impact: 2,
    confidencePct: 100,
    effort: 1,
    isPivot: false,
    status: "proposed",
    targetChannelId: null,
    targetAgentMemberId: null,
    specId: null,
    approvalRequestId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function specFor(backlogItemId: string): PlanningSpecRecord {
  return {
    id: `spec-${backlogItemId}`,
    workspaceId: WS,
    backlogItemId,
    title: `Spec ${backlogItemId}`,
    body: "body",
    status: "draft",
    sessionId: null,
    approvalRequestId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function serviceWith(items: BacklogItemRecord[]): { service: PlanningService; dispatched: string[] } {
  const rows = new Map(items.map((i) => [i.id, { ...i }]));
  const specs = new Map<string, PlanningSpecRecord>();
  const backlog: BacklogStore = {
    async insert() {
      throw new Error("not used");
    },
    async get(_workspaceId, id) {
      return rows.get(id);
    },
    async list() {
      return [...rows.values()];
    },
    async update(_workspaceId, id, patch, now) {
      const current = rows.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch, updatedAt: now };
      rows.set(id, next);
      return next;
    },
  };
  const specStore: SpecStore = {
    async insert(input) {
      const spec = specFor(input.backlogItemId);
      specs.set(input.backlogItemId, spec);
      return spec;
    },
    async getForItem(_workspaceId, backlogItemId) {
      return specs.get(backlogItemId);
    },
    async list() {
      return [...specs.values()];
    },
    async linkSession(_workspaceId, id, sessionId, now) {
      const found = [...specs.values()].find((s) => s.id === id);
      if (!found) return undefined;
      const next = { ...found, sessionId, status: "dispatched" as const, updatedAt: now };
      specs.set(found.backlogItemId, next);
      return next;
    },
    async linkApproval() {
      throw new Error("not used");
    },
  };
  const dispatched: string[] = [];
  const service = new PlanningService({
    backlog,
    specs: specStore,
    dispatcher: {
      async dispatch(input) {
        dispatched.push(input.item.id);
        return { id: `session-${input.item.id}` };
      },
    },
    approvals: { async enqueue() { throw new Error("not used"); } },
    caps: () => ({ enabled: true, autoEffortCeiling: 10, dispatchCostCents: 0, maxDispatchesPerTick: 1 }),
    autoDispatchAllowed: async () => true,
    budgetExhausted: async () => false,
    killSwitch: async () => false,
    now: () => NOW,
  });
  return { service, dispatched };
}

describe("planning steering (#626)", () => {
  it("parses a natural-language focus directive", () => {
    expect(parseSteeringIntent("focus on developers this week")).toEqual({
      intent: "focus on developers this week",
      keywords: ["developer"],
      timeframe: "this_week",
    });
  });

  it("boosts matching backlog items above higher-RICE generic work", () => {
    const generic = item({ id: "generic", title: "Polish homepage", reach: 100 });
    const developers = item({ id: "devs", title: "Developer onboarding fixes", reach: 5 });
    const ranked = rankBacklog([generic, developers], parseSteeringIntent("focus on developers this week"));
    expect(ranked.map((r) => r.item.id)).toEqual(["devs", "generic"]);
    expect(ranked[0].steeringBoost).toBeGreaterThan(0);
  });

  it("changes what the next planning tick dispatches", async () => {
    const generic = item({ id: "generic", title: "Polish homepage", reach: 100 });
    const developers = item({ id: "devs", title: "Developer onboarding fixes", reach: 5 });
    const { service, dispatched } = serviceWith([generic, developers]);

    expect((await service.backlogView(WS))[0]!.item.id).toBe("generic");
    const steered = await service.steer(WS, "focus on developers this week");
    expect(steered.backlog[0]!.item.id).toBe("devs");

    const tick = await service.tick(WS);
    expect(tick.actions[0]!.itemId).toBe("devs");
    expect(dispatched).toEqual(["devs"]);
  });
});
