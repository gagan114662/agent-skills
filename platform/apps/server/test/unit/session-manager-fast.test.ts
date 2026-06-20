import { describe, it, expect } from "vitest";
import { SessionManager, resolveFastCaps } from "../../src/runtime/manager.js";
import type { ChannelPoster, SessionLogger, SessionStore } from "../../src/runtime/manager.js";
import { StaticSecretsResolver as Secrets } from "../../src/runtime/secrets-resolver.js";
import { harnessSpec, type HarnessKind } from "../../src/runtime/harness.js";
import type {
  AgentJob,
  AgentRuntime,
  RunningSession,
  RuntimeHooks,
  RuntimeResult,
} from "../../src/runtime/types.js";
import type { AgentSession, ResourceCaps } from "../../src/db/repositories/agent-sessions.js";

// --- minimal fakes ----------------------------------------------------------

class FakeStore implements SessionStore {
  created?: { command: string; harness?: string | null; caps: ResourceCaps };
  create(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    runtime: "local" | "sandbox";
    command: string;
    caps: ResourceCaps;
    harness?: string | null;
  }): Promise<AgentSession> {
    this.created = { command: input.command, harness: input.harness ?? null, caps: input.caps };
    return Promise.resolve({
      id: "sess_test",
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentMemberId: input.agentMemberId,
      createdByMemberId: input.createdByMemberId,
      runtime: input.runtime,
      status: "provisioning",
      command: input.command,
      harness: (input.harness ?? null) as AgentSession["harness"],
      sandboxId: null,
      snapshotId: null,
      exitCode: null,
      result: null,
      caps: input.caps,
      startedAt: null,
      endedAt: null,
      createdAt: new Date(0),
    });
  }
  markRunning(): Promise<void> {
    return Promise.resolve();
  }
  finalize(): Promise<void> {
    return Promise.resolve();
  }
  forceFinalize(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class FakePoster implements ChannelPoster {
  private seq = 0;
  post(): Promise<{ id: string }> {
    this.seq += 1;
    return Promise.resolve({ id: `msg_${this.seq}` });
  }
}

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Records the job (command/args/caps) it is started with, then completes cleanly. */
class CapturingRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  job?: AgentJob;
  start(job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession> {
    this.job = job;
    hooks.onOutput("stdout", "ack\n");
    return Promise.resolve({
      sessionId: job.sessionId,
      wait: () => Promise.resolve<RuntimeResult>({ status: "completed", exitCode: 0 }),
      cancel: () => Promise.resolve(),
    });
  }
}

const DEFAULT_CAPS: ResourceCaps = { wallClockMs: 600_000, idleMs: 300_000 };

function makeManager() {
  const runtime = new CapturingRuntime();
  const store = new FakeStore();
  const manager = new SessionManager({
    runtime,
    store,
    poster: new FakePoster(),
    secrets: new Secrets({}),
    // The deployment default IS claude-code here (so resolveHarness routes the default kind through
    // the override resolver for a fast launch).
    harness: harnessSpec("claude-code"),
    harnessKind: "claude-code",
    harnessOverrides: (kind: HarnessKind, opts?: { fast?: boolean }) => ({
      ...harnessSpec(kind, { fast: opts?.fast }),
      decode: (line: string) => ({ display: [line], raw: null }),
    }),
    caps: DEFAULT_CAPS,
    logger: silentLogger,
  });
  return { manager, runtime, store };
}

const baseLaunch = {
  workspaceId: "ws_1",
  channelId: "ch_1",
  agentMemberId: "mem_agent",
  createdByMemberId: "mem_human",
  task: "ack the handoff",
};

// --- tests ------------------------------------------------------------------

describe("fast launch plumbing (#417 — threads `fast` to the spec + short caps)", () => {
  it("a fast launch builds the FAST spec (no acceptEdits, empty allowedTools, fast model env)", async () => {
    const { manager, runtime } = makeManager();
    const session = await manager.launch({ ...baseLaunch, fast: true });
    await manager.join(session.id);

    const cmd = runtime.job?.args[1] ?? "";
    expect(cmd).not.toContain("acceptEdits");
    expect(cmd).toContain('--allowedTools ""');
    expect(cmd).toContain('${ANTHROPIC_FAST_MODEL:+--model "$ANTHROPIC_FAST_MODEL"}');
    expect(cmd).toContain('-p "$AGENT_TASK"');
  });

  it("a default launch uses the FULL spec unchanged (acceptEdits, no fast model env)", async () => {
    const { manager, runtime } = makeManager();
    const session = await manager.launch({ ...baseLaunch });
    await manager.join(session.id);

    const cmd = runtime.job?.args[1] ?? "";
    expect(cmd).toContain("--permission-mode acceptEdits");
    expect(cmd).toContain('${ANTHROPIC_MODEL:+--model "$ANTHROPIC_MODEL"}');
    expect(cmd).not.toContain("ANTHROPIC_FAST_MODEL");
  });

  it("a fast launch runs under SHORT caps; a default launch keeps the deployment caps", async () => {
    const { manager, runtime, store } = makeManager();

    const fast = await manager.launch({ ...baseLaunch, fast: true });
    await manager.join(fast.id);
    expect(runtime.job?.caps.idleMs).toBeLessThanOrEqual(DEFAULT_CAPS.idleMs);
    expect(runtime.job?.caps.wallClockMs).toBeLessThanOrEqual(DEFAULT_CAPS.wallClockMs);
    // Persisted with the short caps too (the row reflects what actually ran).
    expect(store.created?.caps.idleMs).toBe(runtime.job?.caps.idleMs);

    const normal = await manager.launch({ ...baseLaunch });
    await manager.join(normal.id);
    expect(runtime.job?.caps).toEqual(DEFAULT_CAPS);
  });
});

describe("resolveFastCaps (#417)", () => {
  const defaults: ResourceCaps = { wallClockMs: 600_000, idleMs: 300_000 };

  it("uses 60s idle / 180s wall defaults when the env overrides are unset", () => {
    expect(resolveFastCaps(defaults, {})).toEqual({
      wallClockMs: 180_000,
      idleMs: 60_000,
    });
  });

  it("honors positive integer env overrides", () => {
    expect(
      resolveFastCaps(defaults, { AGENT_FAST_IDLE_MS: "30000", AGENT_FAST_WALLCLOCK_MS: "90000" }),
    ).toEqual({ wallClockMs: 90_000, idleMs: 30_000 });
  });

  it("never exceeds the default caps (a fast turn is at most as long, never longer)", () => {
    const tiny: ResourceCaps = { wallClockMs: 10_000, idleMs: 5_000 };
    expect(resolveFastCaps(tiny, {})).toEqual({ wallClockMs: 10_000, idleMs: 5_000 });
  });

  it("falls back to the defaults for non-positive / non-numeric values", () => {
    expect(
      resolveFastCaps(defaults, { AGENT_FAST_IDLE_MS: "-1", AGENT_FAST_WALLCLOCK_MS: "nope" }),
    ).toEqual({ wallClockMs: 180_000, idleMs: 60_000 });
  });
});
