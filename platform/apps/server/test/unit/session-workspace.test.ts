import { describe, it, expect } from "vitest";
import { SessionManager } from "../../src/runtime/manager.js";
import type { ChannelPoster, SessionLogger, SessionStore } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import type { WorkspaceProvisioner } from "../../src/config/workspace.js";
import type {
  AgentJob,
  AgentRuntime,
  RunningSession,
  RuntimeHooks,
} from "../../src/runtime/types.js";
import type { AgentSession, ResourceCaps, SessionStatus } from "../../src/db/repositories/agent-sessions.js";

/**
 * The SessionManager workspace seam (#58): when a WorkspaceProvisioner is configured it runs before
 * the runtime starts and its `cwd` is threaded onto the AgentJob. With no provisioner, `cwd` stays
 * undefined — today's behavior, so existing #25 sessions/tests are unchanged.
 */
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

class FakeStore implements SessionStore {
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
      id: "sess_test",
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentMemberId: input.agentMemberId,
      createdByMemberId: input.createdByMemberId,
      runtime: input.runtime,
      status: "provisioning" as SessionStatus,
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
    });
  }
  markRunning(): Promise<void> {
    return Promise.resolve();
  }
  finalize(): Promise<void> {
    return Promise.resolve();
  }
}

const noopPoster: ChannelPoster = {
  post: () => Promise.resolve({ id: "msg" }),
};

/** Records the cwd the manager put on the job, then completes immediately. */
class CapturingRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  capturedCwd: string | undefined = "UNSET";
  start(job: AgentJob, _hooks: RuntimeHooks): Promise<RunningSession> {
    this.capturedCwd = job.cwd;
    return Promise.resolve({
      sessionId: job.sessionId,
      wait: () => Promise.resolve({ status: "completed" as SessionStatus, exitCode: 0 }),
      cancel: () => Promise.resolve(),
    });
  }
}

function manager(runtime: CapturingRuntime, workspace?: WorkspaceProvisioner) {
  return new SessionManager({
    runtime,
    store: new FakeStore(),
    poster: noopPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: "bash", args: ["x.sh"] },
    caps: { wallClockMs: 10_000, idleMs: 10_000 },
    logger: silentLogger,
    workspace,
  });
}

const launch = {
  workspaceId: "ws_1",
  channelId: "ch_1",
  agentMemberId: "mem_agent",
  createdByMemberId: "mem_human",
  task: "do the thing",
};

describe("SessionManager workspace seam (#58)", () => {
  it("threads the provisioner's cwd onto the AgentJob", async () => {
    const runtime = new CapturingRuntime();
    const provisioner: WorkspaceProvisioner = {
      prepare: ({ sessionId }) => Promise.resolve({ cwd: `/tmp/wsroot/${sessionId}` }),
    };
    const m = manager(runtime, provisioner);
    const session = await m.launch(launch);
    await m.join(session.id);
    expect(runtime.capturedCwd).toBe("/tmp/wsroot/sess_test");
  });

  it("leaves cwd undefined when no provisioner is configured (unchanged #25 behavior)", async () => {
    const runtime = new CapturingRuntime();
    const m = manager(runtime);
    const session = await m.launch(launch);
    await m.join(session.id);
    expect(runtime.capturedCwd).toBeUndefined();
  });
});
