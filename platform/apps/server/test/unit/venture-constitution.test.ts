import { describe, it, expect } from "vitest";
import { VentureService } from "../../src/venture/service.js";
import type {
  ConstitutionEvidence,
  ConstitutionGuard,
  EvidenceGatherer,
  PersonaScorer,
  ApprovalEnqueuer,
  MemoryRecorder,
  EpicEmitter,
  VentureRepo,
} from "../../src/venture/service.js";
import { VENTURE_DEFAULTS } from "../../src/venture/caps.js";
import { CONSTITUTION_DEFAULTS } from "../../src/constitution/caps.js";
import { RUBRIC_DIMENSIONS, type PersonaScorecard } from "../../src/venture/rubric.js";
import type {
  Scorecard,
  IterationLogEntry,
  VentureIdea,
  VentureEvaluation,
  VentureSegment,
} from "../../src/venture/types.js";
import type { ConstitutionViolation } from "../../src/constitution/types.js";

function uniform(value: number): PersonaScorecard {
  return Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, value])) as PersonaScorecard;
}

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
        segment: i.segment ?? null,
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

interface Recorded {
  stage: string;
  verdict: string;
  violations: ConstitutionViolation[];
}

/** A fake constitution guard with configurable evidence + a recording log. */
function fakeGuard(opts: {
  enabled?: boolean;
  evidence: ConstitutionEvidence;
}): ConstitutionGuard & { recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  return {
    recorded,
    enabled: () => opts.enabled ?? true,
    caps: () => ({ ...CONSTITUTION_DEFAULTS, enabled: true }),
    evidenceFor: async () => opts.evidence,
    record: async (input) => {
      recorded.push({ stage: input.stage, verdict: input.verdict, violations: input.violations });
    },
  };
}

function build(
  scorer: PersonaScorer,
  constitution?: ConstitutionGuard,
): {
  svc: VentureService;
  spies: { approvals: number; memory: number; epics: number };
} {
  const evidence: EvidenceGatherer = {
    gather: async () => [{ claim: "market is big", source: null, assumption: true }],
  };
  const spies = { approvals: 0, memory: 0, epics: 0 };
  const approvals: ApprovalEnqueuer = {
    enqueue: async () => {
      spies.approvals++;
      return { id: "appr-1" };
    },
  };
  const memory: MemoryRecorder = {
    record: async () => {
      spies.memory++;
      return { id: "mem-1" };
    },
  };
  const epics: EpicEmitter = {
    emit: async () => {
      spies.epics++;
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
    constitution,
    now: () => new Date("2026-06-10T00:00:00Z"),
  });
  return { svc, spies };
}

const fixedScorer = (v: number): PersonaScorer => ({
  score: async () => ({ advocate: uniform(v), reviewer: uniform(v) }),
});

function idea(segment: VentureSegment | null) {
  return { problem: "p", targetUser: "u", insight: "i", wedge: "w", marketPath: "m", segment };
}

const strongEvidence: ConstitutionEvidence = {
  unaffiliatedPayingIntentSignals: 12,
  externalDemandPresent: true,
  paidSignalPresent: true,
};
const noEvidence: ConstitutionEvidence = {
  unaffiliatedPayingIntentSignals: 0,
  externalDemandPresent: false,
  paidSignalPresent: false,
};

describe("VentureService — constitution enforcement (#146)", () => {
  it("Article I: a B2B FUND with no love evidence is downgraded to ESCALATE and flagged", async () => {
    const guard = fakeGuard({ evidence: noEvidence });
    const { svc, spies } = build(fixedScorer(8), guard); // 80 ≥ fund(70) → base FUND
    const i = await svc.submit("ws", idea("b2b"), "m1");
    await svc.score("ws", i.id);
    const result = await svc.decide("ws", i.id);

    expect(result.verdict).toBe("ESCALATE"); // downgraded, not FUND
    expect(spies.epics).toBe(0); // never funded
    expect(spies.approvals).toBe(1); // escalated to a human (the flag's escalation)
    const view = await svc.get("ws", i.id);
    expect(view.idea.status).toBe("escalated");
    expect(view.latestScorecard?.verdict).toBe("ESCALATE");

    // The violation was recorded at the FUND stage with the love-paradigm code.
    const decideRecord = guard.recorded.find((r) => r.stage === "FUND");
    expect(decideRecord).toBeTruthy();
    expect(decideRecord!.violations.map((v) => v.code)).toContain("love_paradigm_unmet");
  });

  it("Article I: a B2B FUND WITH enough love evidence funds normally (no weakening)", async () => {
    const guard = fakeGuard({ evidence: strongEvidence });
    const { svc, spies } = build(fixedScorer(8), guard);
    const i = await svc.submit("ws", idea("b2b"), "m1");
    await svc.score("ws", i.id);
    const result = await svc.decide("ws", i.id);

    expect(result.verdict).toBe("FUND");
    expect(spies.epics).toBe(1);
    const fundRecord = guard.recorded.find((r) => r.stage === "FUND");
    expect(fundRecord).toBeUndefined(); // no violations to record
  });

  it("flag-only: a B2C FUND on synthetic demand still FUNDs but records Article V/VIII flags", async () => {
    const guard = fakeGuard({ evidence: noEvidence });
    const { svc, spies } = build(fixedScorer(8), guard);
    const i = await svc.submit("ws", idea("b2c"), "m1");
    await svc.score("ws", i.id);
    const result = await svc.decide("ws", i.id);

    expect(result.verdict).toBe("FUND"); // love-gate is B2B-only; verdict unchanged
    expect(spies.epics).toBe(1);
    const codes = guard.recorded.find((r) => r.stage === "FUND")!.violations.map((v) => v.code);
    expect(codes).toContain("funded_on_synthetic_demand");
    expect(codes).toContain("funded_without_realized_payment");
    expect(codes).not.toContain("love_paradigm_unmet");
  });

  it("SOURCE: a B2B intake with no demand records an early-warning flag", async () => {
    const guard = fakeGuard({ evidence: noEvidence });
    const { svc } = build(fixedScorer(8), guard);
    await svc.submit("ws", idea("b2b"), "m1");

    const sourceRecord = guard.recorded.find((r) => r.stage === "SOURCE");
    expect(sourceRecord).toBeTruthy();
    expect(sourceRecord!.violations.map((v) => v.code)).toContain("b2b_sourced_without_demand");
  });

  it("is inert when the guard is disabled — behaviour is unchanged", async () => {
    const guard = fakeGuard({ enabled: false, evidence: noEvidence });
    const { svc, spies } = build(fixedScorer(8), guard);
    const i = await svc.submit("ws", idea("b2b"), "m1");
    await svc.score("ws", i.id);
    const result = await svc.decide("ws", i.id);

    expect(result.verdict).toBe("FUND"); // no downgrade
    expect(spies.epics).toBe(1);
    expect(guard.recorded).toHaveLength(0);
  });

  it("is inert when no guard is wired at all (default-OFF)", async () => {
    const { svc, spies } = build(fixedScorer(8)); // no constitution dep
    const i = await svc.submit("ws", idea("b2b"), "m1");
    await svc.score("ws", i.id);
    const result = await svc.decide("ws", i.id);
    expect(result.verdict).toBe("FUND");
    expect(spies.epics).toBe(1);
  });
});
