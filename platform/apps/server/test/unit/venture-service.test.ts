import { describe, it, expect } from "vitest";
import { VentureService } from "../../src/venture/service.js";
import type {
  EvidenceGatherer,
  PersonaScorer,
  ApprovalEnqueuer,
  MemoryRecorder,
  EpicEmitter,
  VentureRepo,
} from "../../src/venture/service.js";
import { VENTURE_DEFAULTS } from "../../src/venture/caps.js";
import { RUBRIC_DIMENSIONS, type PersonaScorecard } from "../../src/venture/rubric.js";
import type {
  Scorecard,
  IterationLogEntry,
  VentureIdea,
  VentureEvaluation,
} from "../../src/venture/types.js";

function uniform(value: number): PersonaScorecard {
  return Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, value])) as PersonaScorecard;
}

/** A minimal in-memory VentureRepo — enough to exercise the orchestrator without a DB. */
function memRepo(): VentureRepo {
  const ideas = new Map<string, VentureIdea>();
  const scorecards: Scorecard[] = [];
  const iterations: IterationLogEntry[] = [];
  const evaluations = new Map<string, VentureEvaluation>();
  let seq = 0;
  const id = () => `id-${++seq}`;
  return {
    createIdea: async (i) => {
      const idea: VentureIdea = {
        id: id(),
        workspaceId: i.workspaceId,
        problem: i.problem,
        targetUser: i.targetUser,
        insight: i.insight,
        wedge: i.wedge,
        marketPath: i.marketPath,
        status: "intake",
        epicTaskId: null,
        createdByMemberId: i.createdByMemberId,
        createdAt: new Date(),
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
        workspaceId: i.workspaceId,
        ideaId: i.ideaId,
        iteration: i.iteration,
        score: i.score,
        verdict: null,
        advocate: i.advocate,
        reviewer: i.reviewer,
        reasoning: i.reasoning,
        funded: false,
        createdAt: new Date(),
        expiresAt: i.expiresAt,
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
      const existing = [...evaluations.values()].find(
        (e) => e.workspaceId === ws && e.ideaId === ideaId,
      );
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
}

interface Spies {
  approvals: ApprovalEnqueuer & { calls: number };
  memory: MemoryRecorder & { calls: number };
  epics: EpicEmitter & { calls: number };
}

function build(scorer: PersonaScorer): { svc: VentureService; spies: Spies } {
  const evidence: EvidenceGatherer = {
    gather: async () => [{ claim: "market is big", source: null, assumption: true }],
  };
  const approvals: Spies["approvals"] = {
    calls: 0,
    enqueue: async function () {
      this.calls++;
      return { id: "appr-1" };
    },
  };
  const memory: Spies["memory"] = {
    calls: 0,
    record: async function () {
      this.calls++;
      return { id: "mem-1" };
    },
  };
  const epics: Spies["epics"] = {
    calls: 0,
    emit: async function () {
      this.calls++;
      return { id: "task-1" };
    },
  };
  const svc = new VentureService({
    repo: memRepo(),
    evidence,
    scorer,
    approvals,
    memory,
    epics,
    caps: () => VENTURE_DEFAULTS,
    now: () => new Date("2026-06-10T00:00:00Z"),
  });
  return { svc, spies: { approvals, memory, epics } };
}

const IDEA = {
  problem: "p",
  targetUser: "u",
  insight: "i",
  wedge: "w",
  marketPath: "m",
};

/** A scorer that always returns the same agreeing scorecard. */
const fixedScorer = (v: number): PersonaScorer => ({
  score: async () => ({ advocate: uniform(v), reviewer: uniform(v) }),
});

describe("VentureService.runLoop", () => {
  it("FUNDs a strong idea: emits an epic, marks the idea funded, funds the scorecard", async () => {
    const { svc, spies } = build(fixedScorer(8)); // → 80 ≥ fund(70)
    const idea = await svc.submit("ws", IDEA, "m1");
    const result = await svc.runLoop("ws", idea.id, "m1");

    expect(result.verdict).toBe("FUND");
    expect(spies.epics.calls).toBe(1);
    expect(spies.memory.calls).toBe(0);
    const view = await svc.get("ws", idea.id);
    expect(view.idea.status).toBe("funded");
    expect(view.idea.epicTaskId).toBe("task-1");
    expect(view.latestScorecard?.verdict).toBe("FUND");
    expect(view.latestScorecard?.funded).toBe(true);
  });

  it("KILLs a weak idea and records the verdict to the memory graph (never blindly retried)", async () => {
    const { svc, spies } = build(fixedScorer(3)); // → 30 ≤ kill(35)
    const idea = await svc.submit("ws", IDEA, "m1");
    const result = await svc.runLoop("ws", idea.id, "m1");

    expect(result.verdict).toBe("KILL");
    expect(spies.memory.calls).toBe(1);
    expect(spies.epics.calls).toBe(0);
    expect((await svc.get("ws", idea.id)).idea.status).toBe("killed");
  });

  it("ESCALATEs a borderline idea to the approvals queue (human-in-the-loop)", async () => {
    const { svc, spies } = build(fixedScorer(6.5)); // → 65, in [60,70) escalate band
    const idea = await svc.submit("ws", IDEA, "m1");
    const result = await svc.runLoop("ws", idea.id, "m1");

    expect(result.verdict).toBe("ESCALATE");
    expect(spies.approvals.calls).toBe(1);
    expect((await svc.get("ws", idea.id)).idea.status).toBe("escalated");
  });

  it("ITERATEs then terminates via the no-repeated-failed-angle check", async () => {
    const { svc, spies } = build(fixedScorer(5)); // → 50 mid-band, every dimension weak
    const idea = await svc.submit("ws", IDEA, "m1");
    const result = await svc.runLoop("ws", idea.id, "m1");

    // Pass 1 ITERATEs (all angles novel); pass 2 sees the same weak angles → ESCALATE (no repeat).
    expect(result.verdict).toBe("ESCALATE");
    expect(result.iterations).toBe(2);
    expect(spies.approvals.calls).toBe(1);
    const view = await svc.get("ws", idea.id);
    expect(view.iterations).toHaveLength(2);
    expect(view.iterations[0].verdict).toBe("ITERATE");
    expect(view.iterations[1].verdict).toBe("ESCALATE");
  });
});
