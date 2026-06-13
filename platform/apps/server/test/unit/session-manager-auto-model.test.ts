import { describe, it, expect } from "vitest";
import { SessionManager } from "../../src/runtime/manager.js";
import type { ChannelPoster, SessionLogger, SessionStore } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { AutoModelResolver } from "../../src/runtime/auto-model.js";
import type { GatewayRoutingClient, GatewayRoutingDecision } from "../../src/runtime/gateway-client.js";
import { CONFIG_DEFAULTS, type ResolvedConfig } from "../../src/config/schema.js";
import type {
  AgentJob,
  AgentRuntime,
  RunningSession,
  RuntimeHooks,
  RuntimeResult,
} from "../../src/runtime/types.js";
import type { AgentSession, ResourceCaps } from "../../src/db/repositories/agent-sessions.js";

// --- fakes ------------------------------------------------------------------

/** Records exactly what create() was asked to persist (the assertion surface for model + "why"). */
class FakeStore implements SessionStore {
  created?: Parameters<SessionStore["create"]>[0];
  create(input: Parameters<SessionStore["create"]>[0]): Promise<AgentSession> {
    this.created = input;
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
      branch: null,
      baseBranch: null,
      headSha: null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      mode: input.mode ?? null,
      selectionMeta: input.selectionMeta ?? null,
      region: null,
      caps: input.caps,
      lastHeartbeatAt: null,
      startedAt: null,
      endedAt: null,
      createdAt: new Date(0),
    } as AgentSession);
  }
  markRunning(): Promise<void> {
    return Promise.resolve();
  }
  finalize(): Promise<void> {
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
  post: () => Promise.resolve({ id: "msg_1" }),
};

/** Captures the env the runtime is started with (to assert ANTHROPIC_MODEL threading), then completes. */
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

const caps: ResourceCaps = { wallClockMs: 10_000, idleMs: 10_000 };

function config(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...CONFIG_DEFAULTS, autoModel: { enabled: true }, ...over };
}

function fakeClient(result: GatewayRoutingDecision | null): GatewayRoutingClient & { calls: number } {
  const client = {
    calls: 0,
    async route() {
      client.calls += 1;
      return result;
    },
  };
  return client;
}

const ACCEPTED: GatewayRoutingDecision = {
  chosen: "claude-sonnet-4-6",
  initialChoice: "claude-haiku-4-5",
  stage: "orchestrator",
  rationale: "ratified claude-sonnet-4-6",
  validationVerdict: "accept",
  confidence: 0.8,
  escalations: [{ from: "claude-haiku-4-5", to: "claude-sonnet-4-6", reason: "low confidence (0.4)" }],
  estCostCents: 0.2,
  actualCostCents: 0.35,
  ok: true,
};

function makeManager(opts: {
  autoModel?: AutoModelResolver;
  runtime?: CapturingRuntime;
}): { manager: SessionManager; store: FakeStore; runtime: CapturingRuntime } {
  const store = new FakeStore();
  const runtime = opts.runtime ?? new CapturingRuntime();
  const manager = new SessionManager({
    runtime,
    store,
    poster: noopPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: "bash", args: ["x.sh"] },
    caps,
    logger: silentLogger,
    autoModel: opts.autoModel,
  });
  return { manager, store, runtime };
}

function resolver(client: GatewayRoutingClient, loadConfig: () => ResolvedConfig = () => config()): AutoModelResolver {
  return new AutoModelResolver({ client, loadConfig, enabled: true, gatewayConfigured: true });
}

const baseLaunch = {
  workspaceId: "ws_owner",
  channelId: "ch_1",
  agentMemberId: "mem_agent",
  createdByMemberId: "mem_human",
  task: "refactor the parser",
};

// --- tests ------------------------------------------------------------------

describe("SessionManager — auto model-selection wiring (convene-llm-gateway)", () => {
  it("auto-selects the model + persists the 'why?' audit when no explicit model is pinned", async () => {
    const client = fakeClient(ACCEPTED);
    const { manager, store, runtime } = makeManager({ autoModel: resolver(client) });

    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);

    expect(client.calls).toBe(1);
    // The chosen model is persisted on the row + threaded into the harness env Claude Code reads.
    expect(store.created?.model).toBe("claude-sonnet-4-6");
    expect(store.created?.provider).toBe("anthropic");
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    // The line-of-control telemetry lands in the session audit trail.
    expect(store.created?.selectionMeta?.chosenModel).toBe("claude-sonnet-4-6");
    expect(store.created?.selectionMeta?.stage).toBe("orchestrator");
    expect(store.created?.selectionMeta?.validationVerdict).toBe("accept");
    expect(store.created?.selectionMeta?.escalations).toHaveLength(1);
    expect(store.created?.selectionMeta?.tenant).toBe("ws_owner");
  });

  it("explicit per-session selection (#52) ALWAYS wins — the resolver is never consulted", async () => {
    const client = fakeClient(ACCEPTED);
    const { manager, store, runtime } = makeManager({ autoModel: resolver(client) });

    const session = await manager.launch({
      ...baseLaunch,
      selection: { provider: "anthropic", model: "claude-opus-4-8", effort: "off", mode: "single" },
      harnessEnv: { ANTHROPIC_MODEL: "claude-opus-4-8" },
    });
    await manager.join(session.id);

    expect(client.calls).toBe(0);
    expect(store.created?.model).toBe("claude-opus-4-8");
    expect(store.created?.selectionMeta).toBeNull();
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBe("claude-opus-4-8");
  });

  it("a model already pinned in harnessEnv (e.g. a persona) wins over auto", async () => {
    const client = fakeClient(ACCEPTED);
    const { manager, store } = makeManager({ autoModel: resolver(client) });

    const session = await manager.launch({ ...baseLaunch, harnessEnv: { ANTHROPIC_MODEL: "claude-haiku-4-5" } });
    await manager.join(session.id);

    expect(client.calls).toBe(0);
    expect(store.created?.model).toBeNull(); // no #52 selection row; env model is untouched
    expect(store.created?.selectionMeta).toBeNull();
  });

  it("no resolver wired ⇒ untouched behavior (deployment default, no model on the row)", async () => {
    const { manager, store, runtime } = makeManager({}); // autoModel undefined
    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);
    expect(store.created?.model).toBeNull();
    expect(store.created?.selectionMeta).toBeNull();
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("flag OFF for the tenant ⇒ untouched behavior even with a resolver wired", async () => {
    const client = fakeClient(ACCEPTED);
    // autoModel.enabled defaults off in CONFIG_DEFAULTS.
    const { manager, store } = makeManager({
      autoModel: resolver(client, () => ({ ...CONFIG_DEFAULTS })),
    });
    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);
    expect(client.calls).toBe(0);
    expect(store.created?.model).toBeNull();
    expect(store.created?.selectionMeta).toBeNull();
  });

  it("gateway unavailable ⇒ the session still launches on the deployment default (never blocked)", async () => {
    const client = fakeClient(null); // gateway down
    const { manager, store, runtime } = makeManager({ autoModel: resolver(client) });
    const session = await manager.launch(baseLaunch);
    await manager.join(session.id);
    expect(client.calls).toBe(1);
    expect(store.created?.model).toBeNull(); // fell back
    expect(store.created?.selectionMeta).toBeNull();
    expect(runtime.job?.env?.ANTHROPIC_MODEL).toBeUndefined();
    expect(session.id).toBe("sess_test"); // the launch succeeded
  });
});
