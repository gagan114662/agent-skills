import { describe, it, expect } from "vitest";
import { SessionManager } from "../../src/runtime/manager.js";
import type { ChannelPoster, SessionLogger, SessionStore } from "../../src/runtime/manager.js";
import type { SecretsResolver } from "../../src/runtime/secrets-resolver.js";
import type {
  AgentJob,
  AgentRuntime,
  RunningSession,
  RuntimeHooks,
  RuntimeResult,
  TerminalReason,
} from "../../src/runtime/types.js";
import { statusForReason } from "../../src/runtime/types.js";
import type { AgentSession, ResourceCaps, SessionStatus } from "../../src/db/repositories/agent-sessions.js";

/**
 * #778 — Stop must hard-halt an agent run. These regression tests prove that the instant Stop is
 * pressed: (1) no further tool/runtime dispatch happens, (2) any in-flight step is aborted, (3) the
 * run reaches the terminal `canceled` state, and (4) no worktree keep-set / process leaks. The three
 * required windows are covered: stop BEFORE the first step, stop MID-tool, and stop BETWEEN steps.
 */

// --- minimal fakes ----------------------------------------------------------

class FakeStore implements SessionStore {
  finalized?: { status: SessionStatus; exitCode?: number | null; result?: string | null };
  private seq = 0;
  create(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    runtime: "local" | "sandbox";
    command: string;
    caps: ResourceCaps;
  }): Promise<AgentSession> {
    return Promise.resolve({
      id: "sess_stop",
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentMemberId: input.agentMemberId,
      createdByMemberId: input.createdByMemberId,
      runtime: input.runtime,
      status: "provisioning",
      command: input.command,
      harness: null,
      sandboxId: null,
      snapshotId: null,
      exitCode: null,
      result: null,
      caps: input.caps,
      startedAt: null,
      endedAt: null,
      createdAt: new Date(0),
    } as AgentSession);
  }
  markRunning(): Promise<void> {
    return Promise.resolve();
  }
  finalize(
    _id: string,
    fields: { status: SessionStatus; exitCode?: number | null; result?: string | null },
  ): Promise<void> {
    this.finalized = fields;
    return Promise.resolve();
  }
  forceFinalize(
    _id: string,
    fields: { status: SessionStatus; result?: string | null; exitCode?: number | null },
  ): Promise<boolean> {
    if (this.finalized) return Promise.resolve(false);
    this.finalized = fields;
    return Promise.resolve(true);
  }
  nextId(): string {
    this.seq += 1;
    return `msg_${this.seq}`;
  }
}

class FakePoster implements ChannelPoster {
  constructor(private readonly store: FakeStore) {}
  post(): Promise<{ id: string }> {
    return Promise.resolve({ id: this.store.nextId() });
  }
}

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Secrets resolver whose resolve() blocks on a manually-released gate (holds drive() pre-dispatch). */
class GateSecrets implements SecretsResolver {
  private release!: () => void;
  private readonly gate = new Promise<void>((r) => {
    this.release = r;
  });
  async resolve(): Promise<Record<string, string>> {
    await this.gate;
    return {};
  }
  open(): void {
    this.release();
  }
}

class StaticSecrets implements SecretsResolver {
  resolve(): Promise<Record<string, string>> {
    return Promise.resolve({});
  }
}

const caps = (over: Partial<ResourceCaps> = {}): ResourceCaps => ({
  wallClockMs: 60_000,
  idleMs: 60_000,
  ...over,
});

const launch = {
  workspaceId: "ws_1",
  channelId: "ch_1",
  agentMemberId: "mem_agent",
  createdByMemberId: "mem_human",
  task: "do the thing",
};

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// --- tests ------------------------------------------------------------------

describe("SessionManager — Stop hard-halts a run (#778)", () => {
  it("stop BEFORE the first step dispatches zero runtime starts and finalizes canceled", async () => {
    let startCount = 0;
    const runtime: AgentRuntime = {
      kind: "local",
      start: (job: AgentJob, _hooks: RuntimeHooks): Promise<RunningSession> => {
        startCount += 1;
        return Promise.resolve({
          sessionId: job.sessionId,
          wait: () => Promise.resolve<RuntimeResult>({ status: "completed", exitCode: 0 }),
          cancel: () => Promise.resolve(),
        });
      },
    };
    const store = new FakeStore();
    const secrets = new GateSecrets();
    const manager = new SessionManager({
      runtime,
      store,
      poster: new FakePoster(store),
      secrets,
      harness: { command: "bash", args: ["x.sh"] },
      caps: caps(),
      logger: silentLogger,
    });

    const session = await manager.launch(launch);
    // drive() is suspended at secrets.resolve(); Stop now, BEFORE the run loop reaches runtime.start().
    const cancelP = manager.cancel(session.id);
    secrets.open(); // let drive() resume — it must observe the cancel and never dispatch.
    expect(await cancelP).toBe(true);

    expect(startCount).toBe(0); // ZERO post-stop dispatch
    expect(store.finalized?.status).toBe("canceled");
    expect(manager.activeCount).toBe(0);
    expect(manager.activeSessionIds).toEqual([]); // no leaked worktree keep-set entry
  });

  it("stop MID-tool aborts the in-flight step, threads the signal to the runtime, and dispatches no more", async () => {
    let startCount = 0;
    let canceledWith: TerminalReason | undefined;
    let signalAtCancel: boolean | undefined;
    const runtime: AgentRuntime = {
      kind: "local",
      start: (job: AgentJob): Promise<RunningSession> => {
        startCount += 1;
        const done = deferred<RuntimeResult>();
        return Promise.resolve({
          sessionId: job.sessionId,
          wait: () => done.promise,
          cancel: (reason: TerminalReason) => {
            canceledWith = reason;
            // #778: the abort signal must thread through to the outbound runtime call.
            signalAtCancel = job.signal?.aborted ?? false;
            done.resolve({ status: statusForReason(reason), exitCode: null });
            return Promise.resolve();
          },
        });
      },
    };
    const store = new FakeStore();
    const manager = new SessionManager({
      runtime,
      store,
      poster: new FakePoster(store),
      secrets: new StaticSecrets(),
      harness: { command: "bash", args: ["x.sh"] },
      caps: caps(),
      logger: silentLogger,
    });

    const session = await manager.launch(launch);
    await tick(); // let drive() reach the running state (one tool/step in flight)
    expect(startCount).toBe(1);

    expect(await manager.cancel(session.id)).toBe(true);
    expect(store.finalized?.status).toBe("canceled");
    expect(canceledWith).toBe("canceled"); // in-flight step torn down — no zombie process
    expect(signalAtCancel).toBe(true); // abort signal reached the outbound runtime call
    expect(startCount).toBe(1); // zero further dispatch
    expect(manager.activeCount).toBe(0);
    expect(manager.activeSessionIds).toEqual([]);
  });

  it("stop BETWEEN steps (during retry backoff) never respawns a new step", async () => {
    let startCount = 0;
    const attempt1Done = deferred();
    const runtime: AgentRuntime = {
      kind: "local",
      start: (job: AgentJob): Promise<RunningSession> => {
        startCount += 1;
        const n = startCount;
        return Promise.resolve({
          sessionId: job.sessionId,
          // Attempt 1 dies pre-progress (failed + null exit, no output) so the loop WOULD retry.
          wait: () => {
            if (n === 1) attempt1Done.resolve();
            return Promise.resolve<RuntimeResult>({ status: "failed", exitCode: null });
          },
          cancel: () => Promise.resolve(),
        });
      },
    };
    const store = new FakeStore();
    const manager = new SessionManager({
      runtime,
      store,
      poster: new FakePoster(store),
      secrets: new StaticSecrets(),
      harness: { command: "bash", args: ["x.sh"] },
      caps: caps(),
      logger: silentLogger,
      sessionRetryMaxAttempts: 3,
      // A long backoff: without an abortable, cancellation-aware wait this test would hang past the
      // vitest timeout; with the fix the cancel wakes the backoff and the loop halts immediately.
      sessionRetryBackoff: { baseMs: 30_000, factor: 1, capMs: 30_000, maxAttempts: 3 },
    });

    const session = await manager.launch(launch);
    await attempt1Done.promise; // attempt 1 has died; the loop is now in the retry backoff
    await tick(); // ensure we are inside the backoff wait
    expect(await manager.cancel(session.id)).toBe(true);

    expect(startCount).toBe(1); // NO respawn after Stop
    expect(store.finalized?.status).toBe("canceled");
    expect(manager.activeCount).toBe(0);
    expect(manager.activeSessionIds).toEqual([]);
  });
});
