import { describe, it, expect } from "vitest";
import { SessionManager } from "../../src/runtime/manager.js";
import type { ChannelPoster, SessionLogger, SessionStore } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { AdmissionError } from "../../src/scale/admission.js";
import type { AdmissionController, AdmissionTicket } from "../../src/scale/admission.js";
import type { UsageRecorder } from "../../src/scale/usage.js";
import type { SpendAnomalyMonitor } from "../../src/scale/spend-anomaly.js";
import type {
  AgentJob,
  AgentRuntime,
  RunningSession,
  RuntimeHooks,
  RuntimeResult,
  ResourceCaps,
  SessionStatus,
} from "../../src/runtime/types.js";
import type { AgentSession } from "../../src/db/repositories/agent-sessions.js";

// --- fakes ------------------------------------------------------------------

class FakeStore implements SessionStore {
  createdCount = 0;
  created?: AgentSession;
  finalized?: { status: SessionStatus };
  region?: string | null;
  constructor(private readonly failCreate = false) {}
  create(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    runtime: "local" | "sandbox";
    command: string;
    caps: ResourceCaps;
    region?: string | null;
  }): Promise<AgentSession> {
    if (this.failCreate) return Promise.reject(new Error("create failed"));
    this.createdCount += 1;
    this.region = input.region ?? null;
    this.created = {
      id: "sess_test",
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentMemberId: input.agentMemberId,
      createdByMemberId: input.createdByMemberId,
      runtime: input.runtime,
      status: "provisioning",
      command: input.command,
      sandboxId: null,
      snapshotId: null,
      exitCode: null,
      result: null,
      branch: null,
      baseBranch: null,
      headSha: null,
      provider: null,
      model: null,
      effort: null,
      mode: null,
      region: input.region ?? null,
      caps: input.caps,
      startedAt: null,
      endedAt: null,
      createdAt: new Date(0),
    } as AgentSession;
    return Promise.resolve(this.created);
  }
  markRunning(): Promise<void> {
    return Promise.resolve();
  }
  finalize(_id: string, fields: { status: SessionStatus }): Promise<void> {
    this.finalized = fields;
    return Promise.resolve();
  }
}

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

const noopPoster: ChannelPoster = {
  post: () => Promise.resolve({ id: "msg" }),
};

/** Captures the job (for asserting region) then completes successfully. */
class CapturingRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  job?: AgentJob;
  start(job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession> {
    this.job = job;
    hooks.onOutput("stdout", "done\n");
    return Promise.resolve({
      sessionId: job.sessionId,
      wait: () => Promise.resolve<RuntimeResult>({ status: "completed", exitCode: 0 }),
      cancel: () => Promise.resolve(),
    });
  }
}

class BlockingRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  canceled = 0;
  private resolve!: (result: RuntimeResult) => void;
  readonly done = new Promise<RuntimeResult>((resolve) => {
    this.resolve = resolve;
  });
  start(_job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession> {
    hooks.onOutput("stdout", "working\n");
    return Promise.resolve({
      sessionId: "sess_test",
      wait: () => this.done,
      cancel: async () => {
        this.canceled += 1;
        this.resolve({ status: "canceled", exitCode: null });
      },
    });
  }
}

class FakeAdmission implements AdmissionController {
  released = 0;
  constructor(private readonly behavior: { region?: string } | { deny: AdmissionError }) {}
  acquire(): Promise<AdmissionTicket> {
    if ("deny" in this.behavior) return Promise.reject(this.behavior.deny);
    const region = this.behavior.region;
    return Promise.resolve({ region, release: () => void (this.released += 1) });
  }
}

class FakeUsage implements UsageRecorder {
  starts: string[] = [];
  computes: { workspaceId: string; seconds: number }[] = [];
  recordStart(workspaceId: string): Promise<void> {
    this.starts.push(workspaceId);
    return Promise.resolve();
  }
  recordCompute(workspaceId: string, computeSeconds: number): Promise<void> {
    this.computes.push({ workspaceId, seconds: computeSeconds });
    return Promise.resolve();
  }
}

const caps: ResourceCaps = { wallClockMs: 10_000, idleMs: 10_000 };
const launch = {
  workspaceId: "ws_1",
  channelId: "ch_1",
  agentMemberId: "mem_agent",
  createdByMemberId: "mem_human",
  task: "do the thing",
};

function makeManager(over: {
  runtime?: AgentRuntime;
  admission?: AdmissionController;
  usage?: UsageRecorder;
  spendAnomaly?: SpendAnomalyMonitor;
  spendAnomalyIntervalMs?: number;
  failCreate?: boolean;
}): { manager: SessionManager; store: FakeStore } {
  const store = new FakeStore(over.failCreate);
  const manager = new SessionManager({
    runtime: over.runtime ?? new CapturingRuntime(),
    store,
    poster: noopPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: "bash", args: ["x.sh"] },
    caps,
    logger: silentLogger,
    admission: over.admission,
    usage: over.usage,
    spendAnomaly: over.spendAnomaly,
    spendAnomalyIntervalMs: over.spendAnomalyIntervalMs,
  });
  return { manager, store };
}

// --- tests ------------------------------------------------------------------

describe("SessionManager × scale (#71 — admission gate, placement, usage, slot release)", () => {
  it("rejects a launch when admission denies it and creates no session row", async () => {
    const admission = new FakeAdmission({ deny: new AdmissionError("budget_exceeded") });
    const { manager, store } = makeManager({ admission });

    await expect(manager.launch(launch)).rejects.toMatchObject({ reason: "budget_exceeded" });
    expect(store.createdCount).toBe(0); // no row created on denial
  });

  it("threads the placed region from the admission ticket into the job and the row", async () => {
    const runtime = new CapturingRuntime();
    const admission = new FakeAdmission({ region: "sfo1" });
    const { manager, store } = makeManager({ runtime, admission });

    const session = await manager.launch(launch);
    await manager.join(session.id);

    expect(runtime.job?.region).toBe("sfo1");
    expect(store.region).toBe("sfo1");
  });

  it("releases the admission slot exactly once at teardown", async () => {
    const admission = new FakeAdmission({ region: "iad1" });
    const { manager } = makeManager({ admission });

    const session = await manager.launch(launch);
    await manager.join(session.id);

    expect(admission.released).toBe(1);
  });

  it("records usage at start and the compute-seconds at finalize", async () => {
    const usage = new FakeUsage();
    const admission = new FakeAdmission({});
    const { manager } = makeManager({ admission, usage });

    const session = await manager.launch(launch);
    await manager.join(session.id);

    expect(usage.starts).toEqual(["ws_1"]);
    expect(usage.computes).toHaveLength(1);
    expect(usage.computes[0]?.workspaceId).toBe("ws_1");
    expect(usage.computes[0]?.seconds).toBeGreaterThanOrEqual(0);
  });

  it("cancels a running session when the spend anomaly guard trips (#926)", async () => {
    const runtime = new BlockingRuntime();
    const spendAnomaly: SpendAnomalyMonitor = {
      async begin() {
        return {
          async check() {
            return {
              kill: true,
              reason: "session_spend_exceeded_half_remaining_budget",
              alerts: [50],
              live: {
                sessionId: "sess_test",
                workspaceId: "ws_1",
                channelId: "ch_1",
                agentMemberId: "mem_agent",
                startedAtMs: 0,
                elapsedSeconds: 1,
                estimatedCostCents: 50,
                budgetCents: 100,
                utilization: 0.5,
                threshold: 50,
              },
            };
          },
          close() {},
        };
      },
    };
    const { manager, store } = makeManager({
      runtime,
      admission: new FakeAdmission({}),
      spendAnomaly,
      spendAnomalyIntervalMs: 250,
    });

    const session = await manager.launch(launch);
    await manager.join(session.id);

    expect(runtime.canceled).toBe(1);
    expect(store.finalized?.status).toBe("canceled");
  });

  it("does not record a usage start when session creation fails (#949)", async () => {
    const usage = new FakeUsage();
    const admission = new FakeAdmission({});
    const { manager, store } = makeManager({ admission, usage, failCreate: true });

    await expect(manager.launch(launch)).rejects.toThrow("create failed");

    expect(store.createdCount).toBe(0);
    expect(usage.starts).toEqual([]);
    expect(admission.released).toBe(1);
  });

  it("works exactly as before when no admission/usage deps are wired (#25 unchanged)", async () => {
    const { manager, store } = makeManager({});
    const session = await manager.launch(launch);
    await manager.join(session.id);
    expect(store.createdCount).toBe(1);
    expect(store.finalized?.status).toBe("completed");
    expect(store.region).toBeNull();
  });
});
