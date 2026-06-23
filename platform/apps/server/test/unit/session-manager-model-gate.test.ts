import { describe, it, expect } from "vitest";
import { SessionManager } from "../../src/runtime/manager.js";
import { DEFAULT_AGENT_MODEL } from "../../src/runtime/models.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import type { ChannelPoster, SessionLogger, SessionStore } from "../../src/runtime/manager.js";
import type { AgentJob, AgentRuntime, RunningSession, RuntimeHooks, RuntimeResult } from "../../src/runtime/types.js";
import type { AgentSession, ResourceCaps } from "../../src/db/repositories/agent-sessions.js";

/**
 * Launch-time model preflight: the SessionManager resolves the EFFECTIVE model at the runtime boundary
 * and ALWAYS injects a launchable model as ANTHROPIC_MODEL before spawning a real `claude-code` session.
 * The fleet runs on a managed, always-valid default (claude-opus-4-8) chosen by ipop. The runtime must
 * never spawn with an empty or invalid model: empty / null / unknown (the `claude-fable-5` class, or an
 * empty "Default" pick) resolves to the managed default and the session runs — it never disables the
 * fleet. (Validation of an admin/dev override still happens at the save path, not here.)
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
  create(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    runtime: "local" | "sandbox";
    command: string;
    caps: ResourceCaps;
    harness?: string | null;
    model?: string | null;
  }): Promise<AgentSession> {
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
      model: input.model ?? null,
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
  agentModel?: string | null;
  workspaceModel: string | null;
  envDefaultModel?: string;
  harnessKind?: "demo" | "claude-code";
}): { manager: SessionManager; store: FakeStore } {
  const store = new FakeStore();
  const manager = new SessionManager({
    runtime: opts.runtime,
    store,
    poster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: "bash", args: ["x.sh"] },
    harnessKind: opts.harnessKind ?? "claude-code",
    caps,
    logger: silentLogger,
    modelForAgent: () => Promise.resolve(opts.agentModel ?? null),
    modelForWorkspace: () => Promise.resolve(opts.workspaceModel),
    envDefaultModel: opts.envDefaultModel,
  });
  return { manager, store };
}

describe("SessionManager model preflight — runtime boundary always yields a launchable model", () => {
  it("an unservable workspace model resolves to the managed default and the session STILL runs (never disabled)", async () => {
    const runtime = new CapturingRuntime();
    const { manager } = makeManager({ runtime, workspaceModel: "claude-fable-5", envDefaultModel: "claude-opus-4-8" });
    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);
    expect(runtime.job).toBeDefined(); // spawned — the fleet is never disabled by a bad value
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBe(DEFAULT_AGENT_MODEL);
  });

  it("an unservable env default + no workspace pick resolves to the managed default and runs", async () => {
    const runtime = new CapturingRuntime();
    const { manager } = makeManager({ runtime, workspaceModel: null, envDefaultModel: "claude-fable-5" });
    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBe(DEFAULT_AGENT_MODEL);
  });

  it("THE BUG: empty workspace pick AND empty env default still injects the managed default — never an empty model", async () => {
    const runtime = new CapturingRuntime();
    // An empty "Default" pick stored as "" + an unset/empty deployment default used to leave
    // ANTHROPIC_MODEL absent → the harness emitted no --model → the fleet was effectively disabled.
    const { manager } = makeManager({ runtime, workspaceModel: "", envDefaultModel: "" });
    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);
    expect(runtime.job).toBeDefined();
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBe(DEFAULT_AGENT_MODEL);
  });

  it("no workspace pick + no env default at all injects the managed default and runs", async () => {
    const runtime = new CapturingRuntime();
    const { manager } = makeManager({ runtime, workspaceModel: null });
    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBe(DEFAULT_AGENT_MODEL);
  });

  it("injects a valid (dev-override) workspace model as ANTHROPIC_MODEL", async () => {
    const runtime = new CapturingRuntime();
    const { manager } = makeManager({ runtime, workspaceModel: "claude-sonnet-4-6", envDefaultModel: "claude-opus-4-8" });
    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
  });

  it("a per-agent model override wins over the workspace pick and is persisted for traces (#662)", async () => {
    const runtime = new CapturingRuntime();
    const { manager, store } = makeManager({
      runtime,
      agentModel: "claude-haiku-4-5",
      workspaceModel: "claude-sonnet-4-6",
      envDefaultModel: "claude-opus-4-8",
    });
    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBe("claude-haiku-4-5");
    expect(store.created?.model).toBe("claude-haiku-4-5");
  });

  it("a per-session model pin wins over the workspace pick", async () => {
    const runtime = new CapturingRuntime();
    const { manager } = makeManager({ runtime, agentModel: "claude-haiku-4-5", workspaceModel: "claude-sonnet-4-6" });
    const session = await manager.launch({ ...baseLaunch, harnessEnv: { ANTHROPIC_MODEL: "claude-opus-4-8" } });
    await manager.join(session.id);
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBe("claude-opus-4-8");
  });

  it("the demo harness is never gated (no model spend, no --model injected)", async () => {
    const runtime = new CapturingRuntime();
    const { manager } = makeManager({ runtime, workspaceModel: "claude-fable-5", harnessKind: "demo" });
    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);
    expect(runtime.job).toBeDefined(); // ran — demo doesn't use a model
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBeUndefined();
  });
});
