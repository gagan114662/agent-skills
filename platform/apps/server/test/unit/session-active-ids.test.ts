import { describe, it, expect } from "vitest";
import { SessionManager } from "../../src/runtime/manager.js";
import type { ChannelPoster, SessionLogger, SessionStore } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import type {
  AgentJob,
  AgentRuntime,
  RunningSession,
  RuntimeHooks,
} from "../../src/runtime/types.js";
import type { AgentSession, ResourceCaps, SessionStatus } from "../../src/db/repositories/agent-sessions.js";

/**
 * #70: the orphan reaper must keep the worktrees of sessions this process is still driving, so the
 * SessionManager exposes its in-memory live set as `activeSessionIds`. Proven with a runtime held
 * open mid-flight: the id is present while running and gone once the run settles.
 */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

class FakeStore implements SessionStore {
  private n = 0;
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
      id: `sess_${++this.n}`,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentMemberId: input.agentMemberId,
      createdByMemberId: input.createdByMemberId,
      runtime: input.runtime,
      status: "provisioning" as SessionStatus,
      command: input.command,
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
}

const noopPoster: ChannelPoster = { post: () => Promise.resolve({ id: "msg" }) };

/** A runtime whose run blocks until `release()` is called, so the session stays "active". */
class GatedRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  private release!: () => void;
  readonly gate = new Promise<void>((r) => (this.release = r));
  start(job: AgentJob, _hooks: RuntimeHooks): Promise<RunningSession> {
    const done = this.gate.then(() => ({ status: "completed" as SessionStatus, exitCode: 0 }));
    return Promise.resolve({
      sessionId: job.sessionId,
      wait: () => done,
      cancel: () => {
        this.release();
        return Promise.resolve();
      },
    });
  }
  open(): void {
    this.release();
  }
}

function manager(runtime: AgentRuntime) {
  return new SessionManager({
    runtime,
    store: new FakeStore(),
    poster: noopPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: "bash", args: ["x.sh"] },
    caps: { wallClockMs: 10_000, idleMs: 10_000 },
    logger: silentLogger,
  });
}

const launch = {
  workspaceId: "ws_1",
  channelId: "ch_1",
  agentMemberId: "mem_agent",
  createdByMemberId: "mem_human",
  task: "do the thing",
};

describe("SessionManager.activeSessionIds (#70)", () => {
  it("lists in-flight session ids and drops them once the run settles", async () => {
    const runtime = new GatedRuntime();
    const m = manager(runtime);
    expect(m.activeSessionIds).toEqual([]);

    const session = await m.launch(launch);
    // Give launch's async drive a tick to register the running session.
    await new Promise((r) => setImmediate(r));
    expect(m.activeSessionIds).toContain(session.id);

    runtime.open();
    await m.join(session.id);
    expect(m.activeSessionIds).not.toContain(session.id);
  });
});
