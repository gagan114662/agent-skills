import { describe, it, expect, beforeEach } from "vitest";
import { VerificationEngine } from "../../src/verification/engine.js";
import type {
  Deliverable,
  DefinitionStore,
  IndependentGrader,
  VerdictStore,
  VerificationApprovalSink,
  WorkerFeedback,
} from "../../src/verification/engine.js";
import { VERIFICATION_DEFAULTS, type VerificationCaps } from "../../src/verification/caps.js";
import type {
  CheckObservation,
  DefinitionOfDoneRecord,
  VerificationVerdictRecord,
} from "../../src/verification/types.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
} as unknown as Parameters<typeof makeEngine>[0]["logger"];

// ---- in-memory fakes for the IO seams ----------------------------------------------------------

function makeStores() {
  const defs: DefinitionOfDoneRecord[] = [];
  const verdicts: VerificationVerdictRecord[] = [];
  let n = 0;
  const definitions: DefinitionStore = {
    record: async (input) => {
      const rec: DefinitionOfDoneRecord = { id: `def-${++n}`, createdAt: new Date(0), ...input };
      defs.push(rec);
      return rec;
    },
    latest: async (ws, ref) =>
      [...defs].reverse().find((d) => d.workspaceId === ws && d.deliverableRef === ref) ?? null,
  };
  const verdictStore: VerdictStore = {
    record: async (input) => {
      const rec: VerificationVerdictRecord = { id: `v-${++n}`, createdAt: new Date(0), ...input };
      verdicts.push(rec);
      return rec;
    },
    countReturns: async (ws, ref) =>
      verdicts.filter(
        (v) => v.workspaceId === ws && v.deliverableRef === ref && v.status === "return_to_worker",
      ).length,
  };
  return { defs, verdicts, definitions, verdictStore };
}

interface Calls {
  approvals: number;
  escalations: number;
  returns: number;
  lastFailures: number;
}

function makeEngine(over: {
  caps?: Partial<VerificationCaps>;
  killSwitch?: boolean;
  grader: IndependentGrader;
  stores?: ReturnType<typeof makeStores>;
  calls?: Calls;
}) {
  const stores = over.stores ?? makeStores();
  const calls: Calls = over.calls ?? { approvals: 0, escalations: 0, returns: 0, lastFailures: 0 };
  const approvals: VerificationApprovalSink = {
    requestApproval: async () => {
      calls.approvals += 1;
      return { id: `req-${calls.approvals}` };
    },
    escalate: async () => {
      calls.escalations += 1;
      return { id: `esc-${calls.escalations}` };
    },
  };
  const feedback: WorkerFeedback = {
    returnToWorker: async ({ failures }) => {
      calls.returns += 1;
      calls.lastFailures = failures.length;
    },
  };
  const engine = new VerificationEngine({
    definitions: stores.definitions,
    verdicts: stores.verdictStore,
    grader: over.grader,
    approvals,
    feedback,
    caps: () => ({ ...VERIFICATION_DEFAULTS, enabled: true, ...over.caps }),
    killSwitch: async () => over.killSwitch ?? false,
    redact: (t) => t,
    logger: silentLogger,
    now: () => new Date(0),
  });
  return { engine, stores, calls };
}

const deliverable = (over: Partial<Deliverable> = {}): Deliverable => ({
  workspaceId: "ws-1",
  deliverableRef: "deliv-1",
  deliverableKind: "support_reply",
  workerMemberId: "worker-1",
  content: "Here is the reply.",
  ...over,
});

/** A grader that returns a satisfied observation for every criterion in the DoD, under a given id. */
const passingGrader = (graderMemberId = "grader-2"): IndependentGrader => ({
  grade: async ({ dod }) => ({
    graderMemberId,
    observations: dod.criteria.map(
      (c): CheckObservation => ({
        criterionId: c.id,
        satisfied: true,
        confidence: 0.95,
        evidence: `met ${c.id}`,
        productionGrounded: c.category === "production",
      }),
    ),
  }),
});

const failingGrader = (graderMemberId = "grader-2"): IndependentGrader => ({
  grade: async ({ dod }) => ({
    graderMemberId,
    observations: dod.criteria.map(
      (c): CheckObservation => ({
        criterionId: c.id,
        satisfied: false,
        confidence: 0.9,
        evidence: `missed ${c.id}`,
        productionGrounded: false,
      }),
    ),
  }),
});

describe("verification/engine", () => {
  let stores: ReturnType<typeof makeStores>;
  beforeEach(() => {
    stores = makeStores();
  });

  it("defineDone derives + persists the criteria before doing (AC #1)", async () => {
    const { engine } = makeEngine({ grader: passingGrader(), stores });
    const rec = await engine.defineDone({
      workspaceId: "ws-1",
      deliverableRef: "deliv-1",
      deliverableKind: "support_reply",
      brief: "Answer the refund question.",
    });
    expect(rec.criteria.length).toBeGreaterThan(0);
    expect(stores.defs).toHaveLength(1);
    // visible: the latest DoD reads back
    expect(await stores.definitions.latest("ws-1", "deliv-1")).not.toBeNull();
  });

  it("is a no-op when the layer is disabled (default behavior unchanged)", async () => {
    const { engine } = makeEngine({ grader: passingGrader(), caps: { enabled: false } });
    const result = await engine.verify(deliverable());
    expect(result).toEqual({ skipped: "disabled" });
  });

  it("opens a #13 approval card with the proof for a verified reversible deliverable (AC #2,#4)", async () => {
    const { engine, calls } = makeEngine({ grader: passingGrader(), stores });
    const result = await engine.verify(deliverable());
    expect("decision" in result && result.decision.action).toBe("request_approval");
    expect(calls.approvals).toBe(1);
    if ("record" in result) {
      expect(result.record.passed).toBe(true);
      expect(result.record.checks.length).toBeGreaterThan(0); // proof persisted
      expect(result.approvalRequestId).toBe("req-1");
    }
  });

  it("ESCALATES and never proceeds when the grader is the worker (no self-grading, AC #2)", async () => {
    const { engine, calls } = makeEngine({ grader: passingGrader("worker-1"), stores });
    const result = await engine.verify(deliverable({ workerMemberId: "worker-1" }));
    expect("decision" in result && result.decision.action).toBe("escalate");
    expect(calls.escalations).toBe(1);
    expect(calls.approvals).toBe(0);
  });

  it("returns the specific failures to the worker on a failed verification (fail→fix, AC #3)", async () => {
    const { engine, calls } = makeEngine({ grader: failingGrader(), stores, caps: { maxRetries: 2 } });
    const result = await engine.verify(deliverable());
    expect("decision" in result && result.decision.action).toBe("return_to_worker");
    expect(calls.returns).toBe(1);
    expect(calls.lastFailures).toBeGreaterThan(0); // the worker is told exactly what failed
  });

  it("escalates after the retry budget is exhausted (repeated failure → decision queue)", async () => {
    const calls: Calls = { approvals: 0, escalations: 0, returns: 0, lastFailures: 0 };
    const grader = failingGrader();
    // Drive maxRetries=1: first failure returns to worker, the next escalates.
    const first = makeEngine({ grader, stores, caps: { maxRetries: 1 }, calls });
    await first.engine.verify(deliverable());
    expect(calls.returns).toBe(1);
    const second = makeEngine({ grader, stores, caps: { maxRetries: 1 }, calls });
    const result = await second.engine.verify(deliverable());
    expect("decision" in result && result.decision.action).toBe("escalate");
    expect(calls.escalations).toBe(1);
  });

  it("auto-proceeds a verified reversible deliverable only when auto-send is opted in", async () => {
    const { engine, calls } = makeEngine({
      grader: passingGrader(),
      stores,
      caps: { autoSendReversible: true },
    });
    const result = await engine.verify(deliverable());
    expect("decision" in result && result.decision.action).toBe("auto_proceed");
    expect(calls.approvals).toBe(0);
    expect(calls.escalations).toBe(0);
  });

  it("an irreversible deliverable is human-gated even with auto-send on (premortem #4)", async () => {
    const { engine } = makeEngine({
      grader: passingGrader(),
      stores,
      caps: { autoSendReversible: true },
    });
    const result = await engine.verify(deliverable({ deliverableKind: "outbound_content" }));
    expect("decision" in result && result.decision.action).toBe("request_approval");
  });
});
