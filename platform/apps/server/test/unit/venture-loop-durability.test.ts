import { describe, it, expect } from "vitest";
import { VentureService } from "../../src/venture/service.js";
import type {
  VentureRepo,
  PersonaScorer,
  UsageMeter,
  VentureServiceDeps,
} from "../../src/venture/service.js";
import { VENTURE_DEFAULTS } from "../../src/venture/caps.js";
import { RUBRIC_DIMENSIONS, type PersonaScorecard } from "../../src/venture/rubric.js";
import type { Scorecard, IterationLogEntry, VentureIdea, VentureEvaluation } from "../../src/venture/types.js";

function uniform(value: number): PersonaScorecard {
  return Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, value])) as PersonaScorecard;
}

/** Shared in-memory store so a "restart" can build a fresh service over the SAME persisted state. */
function memRepo() {
  const ideas = new Map<string, VentureIdea>();
  const scorecards: Scorecard[] = [];
  const iterations: IterationLogEntry[] = [];
  const evaluations = new Map<string, VentureEvaluation>();
  let seq = 0;
  const id = () => `id-${++seq}`;
  const repo: VentureRepo = {
    createIdea: async (i) => {
      const idea: VentureIdea = {
        id: id(),
        status: "intake",
        epicTaskId: null,
        createdAt: new Date(),
        ...i,
      };
      ideas.set(idea.id, idea);
      return idea;
    },
    getIdea: async (ws, ideaId) => {
      const i = ideas.get(ideaId);
      return i && i.workspaceId === ws ? i : undefined;
    },
    updateIdeaStatus: async (ws, ideaId, status) => {
      const i = ideas.get(ideaId);
      if (i && i.workspaceId === ws) i.status = status;
    },
    setIdeaEpic: async (ws, ideaId, epicTaskId) => {
      const i = ideas.get(ideaId);
      if (i && i.workspaceId === ws) i.epicTaskId = epicTaskId;
    },
    insertScorecard: async (i) => {
      const sc: Scorecard = {
        id: id(),
        verdict: null,
        funded: false,
        createdAt: new Date(),
        ...i,
      };
      scorecards.push(sc);
      return sc;
    },
    latestScorecard: async (ws, ideaId) =>
      [...scorecards].reverse().find((s) => s.workspaceId === ws && s.ideaId === ideaId),
    setScorecardVerdict: async (ws, scId, verdict, funded) => {
      const sc = scorecards.find((s) => s.id === scId && s.workspaceId === ws);
      if (sc) {
        sc.verdict = verdict;
        sc.funded = funded;
      }
    },
    insertIteration: async (i) => {
      const it: IterationLogEntry = { id: id(), createdAt: new Date(), ...i };
      iterations.push(it);
      return it;
    },
    listIterations: async (ws, ideaId) =>
      iterations.filter((it) => it.workspaceId === ws && it.ideaId === ideaId),
    getOrCreateEvaluation: async (ws, ideaId) => {
      const existing = [...evaluations.values()].find((e) => e.workspaceId === ws && e.ideaId === ideaId);
      if (existing) return existing;
      const ev: VentureEvaluation = {
        id: id(),
        workspaceId: ws,
        ideaId,
        status: "active",
        terminalVerdict: null,
        currentIteration: 0,
        failedAngles: [],
        lastScore: null,
        costCents: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      evaluations.set(ev.id, ev);
      return ev;
    },
    getEvaluation: async (ws, ideaId) =>
      [...evaluations.values()].find((e) => e.workspaceId === ws && e.ideaId === ideaId),
    updateEvaluation: async (ws, evalId, patch) => {
      const ev = evaluations.get(evalId);
      if (ev && ev.workspaceId === ws) Object.assign(ev, patch, { updatedAt: new Date() });
    },
    listActiveEvaluations: async (ws) =>
      [...evaluations.values()].filter((e) => e.workspaceId === ws && e.status === "active"),
  };
  return { repo, scorecards, evaluations };
}

const IDEA = { problem: "p", targetUser: "u", insight: "i", wedge: "w", marketPath: "m" };
const fixedScorer = (v: number): PersonaScorer => ({
  score: async () => ({ advocate: uniform(v), reviewer: uniform(v) }),
});

let approvalsCalls = 0;
function baseDeps(repo: VentureRepo, over: Partial<VentureServiceDeps> = {}): VentureServiceDeps {
  return {
    repo,
    evidence: { gather: async () => [] },
    scorer: fixedScorer(5), // → 50, mid-band, every dimension weak (ITERATE then no-repeat)
    approvals: {
      enqueue: async () => {
        approvalsCalls++;
        return { id: "appr" };
      },
    },
    memory: { record: async () => ({ id: "mem" }) },
    epics: { emit: async () => ({ id: "epic" }) },
    caps: () => VENTURE_DEFAULTS,
    now: () => new Date("2026-06-10T00:00:00Z"),
    ...over,
  };
}

describe("durable loop state: resume after restart", () => {
  it("a fresh service resumes the evaluation from its persisted cursor, not from iteration 1", async () => {
    const { repo, scorecards, evaluations } = memRepo();

    // First "process": submit + advance once → ITERATE, cursor persisted at iteration 1.
    const svc1 = new VentureService(baseDeps(repo));
    const idea = await svc1.submit("ws", IDEA, "m1");
    const r1 = await svc1.advance("ws", idea.id);
    expect(r1.verdict).toBe("ITERATE");
    const evAfter1 = [...evaluations.values()][0];
    expect(evAfter1.status).toBe("active");
    expect(evAfter1.currentIteration).toBe(1);
    expect(evAfter1.failedAngles.length).toBeGreaterThan(0); // angles remembered durably

    // "Restart": a brand-new service over the SAME repo (no shared in-memory loop state).
    const svc2 = new VentureService(baseDeps(repo));
    const r2 = await svc2.advance("ws", idea.id);

    // It continued at iteration 2 (the no-repeat terminates), proving state came from the DB.
    expect(r2.terminal).toBe(true);
    expect(r2.verdict).toBe("ESCALATE");
    expect(scorecards.map((s) => s.iteration)).toEqual([1, 2]);
    const evAfter2 = [...evaluations.values()][0];
    expect(evAfter2.status).toBe("terminal");
    expect(evAfter2.terminalVerdict).toBe("ESCALATE");
    expect(evAfter2.currentIteration).toBe(2);
  });

  it("never re-advances a terminal evaluation (idempotent after restart)", async () => {
    const { repo, scorecards } = memRepo();
    const svc = new VentureService(baseDeps(repo, { scorer: fixedScorer(8) })); // → FUND immediately
    const idea = await svc.submit("ws", IDEA, "m1");
    await svc.advance("ws", idea.id); // FUND, terminal
    const before = scorecards.length;

    const restarted = new VentureService(baseDeps(repo, { scorer: fixedScorer(8) }));
    const again = await restarted.advance("ws", idea.id);
    expect(again.skipped).toBe("already_terminal");
    expect(scorecards.length).toBe(before); // no new scoring happened
  });
});

describe("dollar ceiling: budget-exhaust mid-loop", () => {
  /** A usage meter backed by a single mutable counter (the tenant's spend this window). */
  function meter(initial = 0): UsageMeter & { spent: number } {
    const m = {
      spent: initial,
      spentCents: async () => m.spent,
      charge: async (_ws: string, cents: number) => {
        m.spent += cents;
      },
    };
    return m;
  }

  it("terminates ESCALATE when a scoring pass tips the tenant over budget", async () => {
    approvalsCalls = 0;
    const { repo, evaluations } = memRepo();
    const usage = meter(0);
    const svc = new VentureService(
      baseDeps(repo, { usage, scaleBudgetCents: () => 150 }), // cost 100/pass, budget 150
    );
    const idea = await svc.submit("ws", IDEA, "m1");

    const r1 = await svc.advance("ws", idea.id); // spend 100 → still under 150 → ITERATE
    expect(r1.verdict).toBe("ITERATE");

    const r2 = await svc.advance("ws", idea.id); // spend 200 → over 150 → forced ESCALATE
    expect(r2.verdict).toBe("ESCALATE");
    expect(r2.terminal).toBe(true);
    expect(r2.budgetExhausted).toBe(true);
    expect(usage.spent).toBe(200);
    const ev = [...evaluations.values()][0];
    expect(ev.terminalVerdict).toBe("ESCALATE");
    expect(approvalsCalls).toBe(1); // escalated to the approvals queue
  });

  it("when the budget is already spent, it escalates WITHOUT scoring (402-semantics gate)", async () => {
    approvalsCalls = 0;
    const { repo, scorecards, evaluations } = memRepo();
    const usage = meter(500); // already way over a 150 budget
    const svc = new VentureService(baseDeps(repo, { usage, scaleBudgetCents: () => 150 }));
    const idea = await svc.submit("ws", idea0(), "m1");

    const r = await svc.advance("ws", idea.id);
    expect(r.budgetExhausted).toBe(true);
    expect(r.terminal).toBe(true);
    expect(r.verdict).toBe("ESCALATE");
    expect(scorecards.length).toBe(0); // no scoring pass was spent
    expect(usage.spent).toBe(500); // nothing charged
    expect([...evaluations.values()][0].terminalVerdict).toBe("ESCALATE");
    expect(approvalsCalls).toBe(1);
  });

  function idea0() {
    return IDEA;
  }
});

describe("infrastructure time: kill switch gates the tick", () => {
  it("a kill-switched workspace does not advance (no score, evaluation stays active)", async () => {
    const { repo, scorecards, evaluations } = memRepo();
    const svc = new VentureService(baseDeps(repo, { killSwitch: async () => true }));
    const idea = await svc.submit("ws", IDEA, "m1");

    const r = await svc.advance("ws", idea.id);
    expect(r.skipped).toBe("kill_switch");
    expect(r.advanced).toBe(false);
    expect(scorecards.length).toBe(0);
    expect([...evaluations.values()][0].status).toBe("active"); // still pending, resumes when cleared
  });

  it("service.tick advances every active evaluation in a workspace", async () => {
    const { repo } = memRepo();
    const svc = new VentureService(baseDeps(repo, { scorer: fixedScorer(8) })); // FUND each
    const a = await svc.submit("ws", IDEA, "m1");
    const b = await svc.submit("ws", IDEA, "m1");

    const results = await svc.tick("ws");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.verdict === "FUND")).toBe(true);
    expect((await svc.get("ws", a.id)).idea.status).toBe("funded");
    expect((await svc.get("ws", b.id)).idea.status).toBe("funded");
  });
});
