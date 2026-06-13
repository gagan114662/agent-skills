import { describe, it, expect } from "vitest";
import { VentureMemoryService, type VentureMemoryDeps } from "../../src/venture-memory/service.js";
import { VENTURE_MEMORY_DEFAULTS, type VentureMemoryCaps } from "../../src/venture-memory/caps.js";
import type { RawVentureNode } from "../../src/venture-memory/memory.js";
import type { OkrRecord, PlanRecord } from "../../src/venture-memory/types.js";

/** A mutable fake of the deps, returning the service + handles to assert against. */
function build(over: {
  caps?: Partial<VentureMemoryCaps>;
  ventures?: { ideaId: string; category?: string | null }[];
  okrs?: OkrRecord[];
  nodes?: RawVentureNode[];
  verifiedMetricCount?: number;
  killSwitch?: boolean;
  openTitles?: string[];
  now?: Date;
} = {}) {
  const plans = new Map<string, PlanRecord>();
  const enqueued: { ideaId: string; planId: string }[] = [];
  const linked: { planId: string; approvalRequestId: string }[] = [];
  let approvalSeq = 0;

  const deps: VentureMemoryDeps = {
    caps: () => ({ ...VENTURE_MEMORY_DEFAULTS, ...over.caps }),
    memory: {
      record: async () => ({ id: "m_new", created: true }),
      nodes: async () => over.nodes ?? [],
    },
    okrs: {
      insert: async (input) => ({
        id: "okr_new",
        workspaceId: input.workspaceId,
        ideaId: input.ideaId,
        objective: input.objective,
        keyResults: input.keyResults,
        status: "active",
        periodKey: input.periodKey ?? "",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      listForVenture: async () => over.okrs ?? [],
    },
    plans: {
      upsert: async (input) => {
        const key = `${input.ideaId}:${input.weekKey}`;
        const existing = plans.get(key);
        if (existing) return { plan: existing, created: false };
        const plan: PlanRecord = {
          id: `plan_${plans.size + 1}`,
          workspaceId: input.workspaceId,
          ideaId: input.ideaId,
          weekKey: input.weekKey,
          status: "draft",
          goNoGo: input.goNoGo,
          rationale: input.rationale,
          premortemCited: input.premortemCited,
          items: input.items,
          approvalRequestId: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
        plans.set(key, plan);
        return { plan, created: true };
      },
      linkApproval: async (_ws, id, approvalRequestId) => {
        linked.push({ planId: id, approvalRequestId });
        for (const p of plans.values()) if (p.id === id) p.approvalRequestId = approvalRequestId;
        return undefined;
      },
    },
    playbooks: { upsert: async () => ({ playbook: {} as never, created: true }), list: async () => [] },
    ventures: { ventures: async () => over.ventures ?? [] },
    scorecard: {
      verifiedMetricCount: async () => over.verifiedMetricCount ?? 0,
      latestScore: async () => 70,
    },
    backlog: { openTitles: async () => over.openTitles ?? [] },
    approvals: {
      enqueue: async ({ ideaId, plan }) => {
        approvalSeq += 1;
        const id = `req_${approvalSeq}`;
        enqueued.push({ ideaId, planId: plan.id });
        return { id };
      },
    },
    killSwitch: async () => over.killSwitch ?? false,
    now: () => over.now ?? new Date("2026-06-13T00:00:00Z"),
  };
  return { service: new VentureMemoryService(deps), plans, enqueued, linked };
}

function okr(keyResults: OkrRecord["keyResults"]): OkrRecord {
  return {
    id: "okr_1",
    workspaceId: "ws_1",
    ideaId: "idea_1",
    objective: "Reach PMF",
    keyResults,
    status: "active",
    periodKey: "",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("VentureMemoryService.tick: default-OFF + kill switch", () => {
  it("is a no-op when disabled (the weekly tick is opt-in)", async () => {
    const { service } = build({ caps: { enabled: false } });
    expect((await service.tick("ws_1")).skipped).toBe("disabled");
  });

  it("skips when the kill switch is engaged", async () => {
    const { service } = build({ caps: { enabled: true }, killSwitch: true, ventures: [{ ideaId: "idea_1" }] });
    expect((await service.tick("ws_1")).skipped).toBe("kill_switch");
  });
});

describe("VentureMemoryService.tick: draft + gate", () => {
  it("drafts a plan with items, gates it via #13, and links the approval", async () => {
    const { service, enqueued, linked } = build({
      caps: { enabled: true },
      ventures: [{ ideaId: "idea_1" }],
      verifiedMetricCount: 1,
      okrs: [
        okr([
          { metric: "MRR", target: 1000, current: 100, unit: "usd", verified: false, source: null },
        ]),
      ],
    });
    const result = await service.tick("ws_1");
    expect(result.skipped).toBeUndefined();
    expect(result.actions).toHaveLength(1);
    const action = result.actions[0]!;
    expect(action.goNoGo).toBe("go"); // 1 verified metric receipt
    expect(action.itemCount).toBeGreaterThan(0);
    expect(action.approvalRequestId).toBeDefined();
    expect(enqueued).toHaveLength(1);
    expect(linked).toHaveLength(1);
  });

  it("is idempotent across a repeat tick in the same week (no second approval)", async () => {
    const { service, enqueued } = build({
      caps: { enabled: true },
      ventures: [{ ideaId: "idea_1" }],
      verifiedMetricCount: 0,
      okrs: [okr([{ metric: "x", target: 10, current: 1, unit: "n", verified: true, source: "vr" }])],
    });
    await service.tick("ws_1");
    await service.tick("ws_1");
    expect(enqueued).toHaveLength(1); // the second tick re-finds the same week's plan (created:false)
  });

  it("does not gate a plan with zero items", async () => {
    const { service, enqueued, plans } = build({
      caps: { enabled: true },
      ventures: [{ ideaId: "idea_1" }],
      verifiedMetricCount: 1,
      okrs: [], // no drift, no memories → no items
    });
    const result = await service.tick("ws_1");
    expect(result.actions[0]!.itemCount).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect([...plans.values()][0]!.approvalRequestId).toBeNull();
  });
});

describe("VentureMemoryService reads", () => {
  const node = (id: string, kind: string, text: string, over: Partial<RawVentureNode> = {}): RawVentureNode => ({
    id,
    content: { text, kind },
    entity: "venture:idea_1",
    createdAtMs: 0,
    stale: false,
    ...over,
  });

  it("recallMemories decodes + dedupes the venture's nodes", async () => {
    const { service } = build({
      nodes: [node("a", "worked", "Cold email worked"), node("b", "worked", "cold email worked!")],
    });
    const out = await service.recallMemories("ws_1", "idea_1");
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("a");
  });

  it("sessionBrief injects memory + OKR drift", async () => {
    const { service } = build({
      caps: { enabled: true, maxBriefPerKind: 5 },
      nodes: [node("a", "customer_voice", "users want CSV")],
      okrs: [okr([{ metric: "MRR", target: 1000, current: 100, unit: "usd", verified: false, source: null }])],
    });
    const brief = await service.sessionBrief("ws_1", "idea_1");
    expect(brief).toContain("Venture memory (idea_1)");
    expect(brief).toContain("Customer voice");
    expect(brief).toContain("OKRs");
  });

  it("beliefs surfaces superseded nodes separately (the 'what does it believe' audit)", async () => {
    const { service } = build({
      caps: { enabled: true, staleAfterDays: 45 },
      nodes: [node("fresh", "worked", "a", { createdAtMs: new Date("2026-06-13T00:00:00Z").getTime() }), node("old", "worked", "b", { stale: true })],
      now: new Date("2026-06-13T00:00:00Z"),
    });
    const beliefs = await service.beliefs("ws_1", "idea_1");
    expect(beliefs.fresh.map((e) => e.id)).toContain("fresh");
    expect(beliefs.superseded.map((e) => e.id)).toContain("old");
  });
});
