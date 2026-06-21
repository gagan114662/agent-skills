import { describe, it, expect } from "vitest";
import { DecisionService, type DecisionDeps, type RecordDecisionPersist } from "../../src/decisions/service.js";
import type { AgentDecisionRow } from "../../src/db/repositories/agent-decisions.js";

/**
 * DecisionService (issue #513) over fakes — proves the orchestration without a DB: sanitize → mirror into
 * the #15 graph → park external/money behind the #13 gate → persist (idempotent) → recall as a clean brief.
 */

interface Calls {
  record: RecordDecisionPersist[];
  mirror: { topic: string; title: string; rationale: string; dedupeKey: string }[];
  park: { actionType: string; amount: number | null; summary: string }[];
  link: { taskId: string; memoryId: string }[];
  supersede: (RecordDecisionPersist & { oldId: string })[];
}

function makeDeps(overrides: Partial<DecisionDeps> = {}): { deps: DecisionDeps; calls: Calls } {
  const calls: Calls = { record: [], mirror: [], park: [], link: [], supersede: [] };
  const deps: DecisionDeps = {
    record: async (input) => {
      calls.record.push(input);
      return { id: "dec-1", created: true };
    },
    supersede: async (input) => {
      calls.supersede.push(input);
      return { newId: "dec-2", created: true, superseded: true };
    },
    getDecision: async () => undefined,
    listDecisions: async () => [],
    recallDecisions: async () => [],
    mirrorToMemory: async (input) => {
      calls.mirror.push(input);
      return "mem-1";
    },
    parkApproval: async (input) => {
      calls.park.push(input);
      return "appr-1";
    },
    linkTaskMemory: async (input) => {
      calls.link.push(input);
    },
    ...overrides,
  };
  return { deps, calls };
}

const base = {
  workspaceId: "w1",
  decidedByMemberId: "m-agent-a",
  topic: "Brand Voice",
  title: "Okay, so I think we use a warm plain tone",
  rationale: "@scout It reads more human via A2A handoff",
};

describe("DecisionService.record", () => {
  it("sanitizes user-facing fields and mirrors the same identity into the memory graph", async () => {
    const { deps, calls } = makeDeps();
    const out = await new DecisionService(deps).record(base);

    // chatter stripped, lead-in peeled, topic normalized
    expect(out.title).toBe("we use a warm plain tone");
    expect(out.rationale).not.toMatch(/@scout|A2A|hand[- ]?off/i);
    expect(out.topic).toBe("brand voice");
    // the mirror got the SAME sanitized values + dedupe key the row did (one logical identity)
    expect(calls.mirror).toHaveLength(1);
    expect(calls.record).toHaveLength(1);
    expect(calls.mirror[0]!.dedupeKey).toBe(calls.record[0]!.dedupeKey);
    expect(calls.record[0]!.memoryId).toBe("mem-1");
    expect(out.memoryId).toBe("mem-1");
    expect(out.pendingApproval).toBe(false);
    expect(out.approvalRequestId).toBeNull();
    expect(out.created).toBe(true);
  });

  it("parks an external/money action behind the #13 gate and marks the decision pending", async () => {
    const { deps, calls } = makeDeps();
    const out = await new DecisionService(deps).record({
      ...base,
      external: { actionType: "external.send", amount: 5000, summary: "Buy the domain" },
    });
    expect(calls.park).toHaveLength(1);
    expect(calls.park[0]).toMatchObject({ actionType: "external.send", amount: 5000 });
    expect(out.approvalRequestId).toBe("appr-1");
    expect(out.pendingApproval).toBe(true);
    // the row references the parked request
    expect(calls.record[0]!.approvalRequestId).toBe("appr-1");
  });

  it("does NOT park an approval for an ordinary internal decision", async () => {
    const { deps, calls } = makeDeps();
    await new DecisionService(deps).record(base);
    expect(calls.park).toHaveLength(0);
  });

  it("links the decision's memory node to its task when a taskId is given", async () => {
    const { deps, calls } = makeDeps();
    await new DecisionService(deps).record({ ...base, taskId: "task-9" });
    expect(calls.link).toEqual([{ workspaceId: "w1", taskId: "task-9", memoryId: "mem-1", createdByMemberId: "m-agent-a" }]);
  });

  it("propagates created:false when the row already existed (idempotent re-record)", async () => {
    const { deps } = makeDeps({ record: async () => ({ id: "dec-1", created: false }) });
    expect((await new DecisionService(deps).record(base)).created).toBe(false);
  });
});

describe("DecisionService.recall", () => {
  it("maps rows to clean recalled decisions plus a chatter-free brief", async () => {
    const rows: AgentDecisionRow[] = [
      {
        id: "d1",
        workspaceId: "w1",
        topic: "pricing",
        title: "Go monthly",
        rationale: "Lower friction",
        decidedByMemberId: "m1",
        status: "recorded",
        memoryId: "mem-x",
        taskId: null,
        approvalRequestId: null,
        supersededByDecisionId: null,
        createdAt: new Date("2026-06-10T00:00:00Z"),
        supersededAt: null,
      },
    ];
    const { deps } = makeDeps({ recallDecisions: async () => rows });
    const out = await new DecisionService(deps).recall("w1", { topic: "Pricing" });
    expect(out.decisions).toEqual([
      { id: "d1", topic: "pricing", title: "Go monthly", rationale: "Lower friction", decidedAt: rows[0]!.createdAt },
    ]);
    expect(out.brief).toContain("Go monthly");
  });

  it("normalizes the recall topic before querying", async () => {
    let seen: { topic?: string } | undefined;
    const { deps } = makeDeps({
      recallDecisions: async (_w, q) => {
        seen = q;
        return [];
      },
    });
    await new DecisionService(deps).recall("w1", { topic: "  Brand   VOICE " });
    expect(seen?.topic).toBe("brand voice");
  });
});

describe("DecisionService.supersede", () => {
  it("supersedes by old id and reports the superseded id", async () => {
    const { deps, calls } = makeDeps();
    const out = await new DecisionService(deps).supersede("old-1", base);
    expect(calls.supersede[0]!.oldId).toBe("old-1");
    expect(out.supersededId).toBe("old-1");
    expect(out.id).toBe("dec-2");
  });
});
