import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  VerifierRunner,
  type ObservationSource,
  type VerifierClaimSource,
  type VerifierEscalator,
  type VerifierResultStore,
  type VerifiedWinRecorder,
} from "../../src/verifiers/engine.js";
import { VERIFIER_DEFAULTS, type VerifierCaps } from "../../src/verifiers/caps.js";
import { resetMetrics } from "../../src/observability/metrics.js";
import { newId } from "../../src/db/id.js";
import type {
  Observation,
  ObservationError,
  VerifierClaim,
  VerifierResultRecord,
} from "../../src/verifiers/types.js";

const silentLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
} as const;

const NOW = new Date("2026-06-11T12:00:00Z");

/** An in-memory result store recording every persisted verdict. */
function memStore(): VerifierResultStore & { rows: VerifierResultRecord[] } {
  const rows: VerifierResultRecord[] = [];
  return {
    rows,
    async record(input) {
      const row: VerifierResultRecord = {
        id: newId(),
        workspaceId: input.workspaceId,
        kind: input.kind,
        claimRef: input.claimRef,
        status: input.status,
        measuredValue: input.measuredValue,
        threshold: input.threshold,
        detail: input.detail,
        escalationRequestId: input.escalationRequestId ?? null,
        source: input.source ?? null,
        createdAt: input.now,
      };
      rows.push(row);
      return row;
    },
  };
}

function fixedObservation(o: Observation | ObservationError): ObservationSource {
  return { observe: async () => o };
}

function countingEscalator(): VerifierEscalator & { calls: number } {
  return {
    calls: 0,
    async escalate() {
      this.calls += 1;
      return { id: `req-${this.calls}` };
    },
  };
}

const claim: VerifierClaim = {
  workspaceId: "ws-1",
  kind: "deploy_live",
  claimRef: "https://app.example.com",
  target: 200,
  source: "deploy",
};

interface Harness {
  runner: VerifierRunner;
  store: ReturnType<typeof memStore>;
  escalator: ReturnType<typeof countingEscalator>;
}

function build(opts: {
  observation: Observation | ObservationError;
  caps?: Partial<VerifierCaps>;
  killSwitch?: boolean;
  maintenance?: boolean;
  due?: VerifierClaim[];
  playbooks?: VerifiedWinRecorder;
}): Harness {
  const store = memStore();
  const escalator = countingEscalator();
  const claims: VerifierClaimSource = { listDue: async () => opts.due ?? [] };
  const runner = new VerifierRunner({
    observations: fixedObservation(opts.observation),
    results: store,
    escalator,
    claims,
    caps: () => ({ ...VERIFIER_DEFAULTS, enabled: true, ...opts.caps }),
    killSwitch: async () => opts.killSwitch ?? false,
    activeWorkspaces: async () => ["ws-1"],
    redact: (t) => t,
    maintenancePaused: async () => opts.maintenance ?? false,
    playbooks: opts.playbooks,
    logger: silentLogger,
    now: () => NOW,
  });
  return { runner, store, escalator };
}

describe("VerifierRunner.verify", () => {
  beforeEach(() => resetMetrics());

  it("persists a passed row and opens NO escalation on a pass", async () => {
    const { runner, store, escalator } = build({
      observation: { kind: "deploy_live", httpStatus: 200, healthy: true },
    });
    const { action } = await runner.verify(claim);
    expect(action).toBe("record_pass");
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: "passed", escalationRequestId: null });
    expect(escalator.calls).toBe(0);
  });

  it("distills a passed verifier outcome into the playbook learning hook (#888)", async () => {
    const wins: Parameters<VerifiedWinRecorder["record"]>[0][] = [];
    const { runner, store } = build({
      observation: { kind: "deploy_live", httpStatus: 200, healthy: true },
      playbooks: { record: async (input) => void wins.push(input) },
    });

    const { action } = await runner.verify(claim);

    expect(action).toBe("record_pass");
    expect(wins).toHaveLength(1);
    expect(wins[0]!.claim).toBe(claim);
    expect(wins[0]!.record).toBe(store.rows[0]);
    expect(wins[0]!.outcome.detail).toContain("deploy live");
  });

  it("does not let playbook distillation failures change the verifier verdict (#888)", async () => {
    const { runner, store } = build({
      observation: { kind: "deploy_live", httpStatus: 200, healthy: true },
      playbooks: {
        record: async () => {
          throw new Error("playbook store down");
        },
      },
    });

    const { action, record } = await runner.verify(claim);

    expect(action).toBe("record_pass");
    expect(record.status).toBe("passed");
    expect(store.rows).toHaveLength(1);
  });

  it("persists a failed row AND opens exactly one escalation, stamping the request id", async () => {
    const { runner, store, escalator } = build({
      observation: { kind: "deploy_live", httpStatus: 500, healthy: false },
    });
    const { action } = await runner.verify(claim);
    expect(action).toBe("escalate");
    expect(escalator.calls).toBe(1);
    expect(store.rows[0]).toMatchObject({ status: "failed", escalationRequestId: "req-1" });
  });

  it("records failed but does NOT escalate when escalateOnFailure is off (still never 'passed')", async () => {
    const { runner, escalator } = build({
      observation: { kind: "deploy_live", httpStatus: 500, healthy: false },
      caps: { escalateOnFailure: false },
    });
    const { record } = await runner.verify(claim);
    expect(record.status).toBe("failed");
    expect(escalator.calls).toBe(0);
  });

  it("records an errored row and never escalates on an un-measurable probe", async () => {
    const { runner, escalator } = build({
      observation: { kind: "deploy_live", errored: true, reason: "ECONNREFUSED" },
    });
    const { record, action } = await runner.verify(claim);
    expect(action).toBe("skip");
    expect(record.status).toBe("errored");
    expect(escalator.calls).toBe(0);
  });

  it("persists failed even when the escalator throws (the verdict is never lost)", async () => {
    const { runner } = build({
      observation: { kind: "deploy_live", httpStatus: 500, healthy: false },
    });
    // override escalator to throw
    (runner as unknown as { deps: { escalator: VerifierEscalator } }).deps.escalator = {
      escalate: async () => {
        throw new Error("queue down");
      },
    };
    const { record } = await runner.verify(claim);
    expect(record.status).toBe("failed");
    expect(record.escalationRequestId).toBeNull();
  });

  it("folds a thrown observation probe into an errored verdict (never a false fail)", async () => {
    const store = memStore();
    const escalator = countingEscalator();
    const runner = new VerifierRunner({
      observations: {
        observe: async () => {
          throw new Error("boom");
        },
      },
      results: store,
      escalator,
      claims: { listDue: async () => [] },
      caps: () => ({ ...VERIFIER_DEFAULTS, enabled: true }),
      killSwitch: async () => false,
      activeWorkspaces: async () => [],
      redact: (t) => t,
      logger: silentLogger,
      now: () => NOW,
    });
    const { record } = await runner.verify(claim);
    expect(record.status).toBe("errored");
    expect(escalator.calls).toBe(0);
  });

  it("redacts the detail before persisting", async () => {
    const store = memStore();
    const runner = new VerifierRunner({
      observations: fixedObservation({ kind: "deploy_live", httpStatus: 200, healthy: true }),
      results: store,
      escalator: countingEscalator(),
      claims: { listDue: async () => [] },
      caps: () => ({ ...VERIFIER_DEFAULTS, enabled: true }),
      killSwitch: async () => false,
      activeWorkspaces: async () => [],
      redact: () => "[REDACTED]",
      logger: silentLogger,
      now: () => NOW,
    });
    const { record } = await runner.verify(claim);
    expect(record.detail).toBe("[REDACTED]");
  });
});

describe("VerifierRunner.tickWorkspace — gating", () => {
  beforeEach(() => resetMetrics());

  it("verifies every due claim when enabled", async () => {
    const due: VerifierClaim[] = [
      { ...claim, claimRef: "https://a" },
      { ...claim, claimRef: "https://b" },
    ];
    const { runner, store } = build({
      observation: { kind: "deploy_live", httpStatus: 200, healthy: true },
      due,
    });
    const res = await runner.tickWorkspace("ws-1");
    expect(res.verified).toHaveLength(2);
    expect(store.rows).toHaveLength(2);
  });

  it("skips the whole pass when the config flag is OFF (no store/escalator calls)", async () => {
    const { runner, store, escalator } = build({
      observation: { kind: "deploy_live", httpStatus: 500, healthy: false },
      caps: { enabled: false },
      due: [claim],
    });
    const res = await runner.tickWorkspace("ws-1");
    expect(res.skipped).toBe("disabled");
    expect(store.rows).toHaveLength(0);
    expect(escalator.calls).toBe(0);
  });

  it("skips the whole pass when the kill switch is engaged", async () => {
    const { runner, store } = build({
      observation: { kind: "deploy_live", httpStatus: 500, healthy: false },
      killSwitch: true,
      due: [claim],
    });
    const res = await runner.tickWorkspace("ws-1");
    expect(res.skipped).toBe("kill_switch");
    expect(store.rows).toHaveLength(0);
  });

  it("honours maxPerTick", async () => {
    const due = Array.from({ length: 5 }, (_, i) => ({ ...claim, claimRef: `https://${i}` }));
    const { runner, store } = build({
      observation: { kind: "deploy_live", httpStatus: 200, healthy: true },
      caps: { maxPerTick: 2 },
      due,
    });
    const res = await runner.tickWorkspace("ws-1");
    expect(res.verified).toHaveLength(2);
    expect(store.rows).toHaveLength(2);
  });
});

describe("VerifierRunner.tickAll — maintenance", () => {
  beforeEach(() => resetMetrics());

  it("skips before any DB call when maintenance is active", async () => {
    const listDue = vi.fn(async () => [] as VerifierClaim[]);
    const store = memStore();
    const runner = new VerifierRunner({
      observations: fixedObservation({ kind: "deploy_live", httpStatus: 200, healthy: true }),
      results: store,
      escalator: countingEscalator(),
      claims: { listDue },
      caps: () => ({ ...VERIFIER_DEFAULTS, enabled: true }),
      killSwitch: async () => false,
      activeWorkspaces: async () => ["ws-1"],
      redact: (t) => t,
      maintenancePaused: async () => true,
      logger: silentLogger,
      now: () => NOW,
    });
    await runner.tickAll();
    expect(listDue).not.toHaveBeenCalled();
  });
});
