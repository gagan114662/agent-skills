import { describe, it, expect } from "vitest";
import { SessionManager } from "../../src/runtime/manager.js";
import { ModelUnavailableError } from "../../src/runtime/models.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import type { ChannelPoster, SessionLogger, SessionStore } from "../../src/runtime/manager.js";
import type { AgentJob, AgentRuntime, RunningSession, RuntimeHooks, RuntimeResult } from "../../src/runtime/types.js";
import type { AgentSession, ResourceCaps } from "../../src/db/repositories/agent-sessions.js";

/**
 * #246 launch-time model preflight: the SessionManager validates the EFFECTIVE model before spawning a
 * real `claude-code` session, throwing an actionable ModelUnavailableError for an unservable id (the
 * `claude-fable-5` class) instead of spawning a doomed session that crashes mid-run — and injecting the
 * workspace's owner-picked model as ANTHROPIC_MODEL when no per-session model is pinned.
 */

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

class FakeStore implements SessionStore {
  created?: AgentSession;
  create(input: { workspaceId: string; channelId: string; agentMemberId: string; createdByMemberId: string; runtime: "local" | "sandbox"; command: string; caps: ResourceCaps; harness?: string | null }): Promise<AgentSession> {
    this.created = {
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
    } as AgentSession;
    return Promise.resolve(this.created);
  }
  markRunning(): Promise<void> { return Promise.resolve(); }
  finalize(): Promise<void> { return Promise.resolve(); }
}

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};
const poster: ChannelPoster = { post: () => Promise.resolve({ id: "m" }) };
const caps: ResourceCaps = { wallClockMs: 10_000, idleMs: 10_000 };
const baseLaunch = { workspaceId: "ws_1", channelId: "ch_1", agentMemberId: "mem_a", createdByMemberId: "mem_h", task: "go" };

function makeManager(opts: {
  runtime: AgentRuntime;
  workspaceModel: string | null;
  envDefaultModel?: string;
  harnessKind?: "demo" | "claude-code";
}) {
  return new SessionManager({
    runtime: opts.runtime,
    store: new FakeStore(),
    poster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: "bash", args: ["x.sh"] },
    harnessKind: opts.harnessKind ?? "claude-code",
    caps,
    logger: silentLogger,
    modelForWorkspace: () => Promise.resolve(opts.workspaceModel),
    envDefaultModel: opts.envDefaultModel,
  });
}

describe("SessionManager model preflight (#246)", () => {
  it("throws ModelUnavailableError BEFORE spawning when the workspace model is unservable", async () => {
    const runtime = new CapturingRuntime();
    const manager = makeManager({ runtime, workspaceModel: "claude-fable-5" });
    await expect(manager.launch(baseLaunch)).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(runtime.job).toBeUndefined(); // never spawned — no doomed session
  });

  it("throws when the env default model is unservable and the workspace pinned none", async () => {
    const runtime = new CapturingRuntime();
    const manager = makeManager({ runtime, workspaceModel: null, envDefaultModel: "claude-fable-5" });
    await expect(manager.launch(baseLaunch)).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(runtime.job).toBeUndefined();
  });

  it("injects the workspace's valid owner-picked model as ANTHROPIC_MODEL", async () => {
    const runtime = new CapturingRuntime();
    const manager = makeManager({ runtime, workspaceModel: "claude-sonnet-4-6", envDefaultModel: "claude-opus-4-8" });
    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
  });

  it("a per-session model pin wins over the workspace pick and is validated", async () => {
    const runtime = new CapturingRuntime();
    const manager = makeManager({ runtime, workspaceModel: "claude-sonnet-4-6" });
    const session = await manager.launch({ ...baseLaunch, harnessEnv: { ANTHROPIC_MODEL: "claude-haiku-4-5" } });
    await manager.join(session.id);
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBe("claude-haiku-4-5");
  });

  it("no workspace pick + valid env default ⇒ does not inject (child inherits process env) and runs", async () => {
    const runtime = new CapturingRuntime();
    const manager = makeManager({ runtime, workspaceModel: null, envDefaultModel: "claude-opus-4-8" });
    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("the demo harness is never gated (no model spend, no --model)", async () => {
    const runtime = new CapturingRuntime();
    const manager = makeManager({ runtime, workspaceModel: "claude-fable-5", harnessKind: "demo" });
    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);
    expect(runtime.job).toBeDefined(); // ran despite the bad model — demo doesn't use it
  });
});
