/**
 * THE no-codex invariant (#1568, live QA rounds 2–3): on a Claude deployment
 * (`AGENT_RUNTIME_PROVIDER` unset/`claude`) **no launch path may ever spawn the codex CLI** — no
 * matter how the codex kind sneaks in: an explicit per-session override (stale web bundle, the
 * retry route replaying a PERSISTED pre-switch session row), a poisoned DEFAULT harness (a stale
 * `AGENT_HARNESS=codex` left in the deployment env), or a fast coordination turn on that default.
 * Every prod leak so far (`codex_core::shell_snapshot ERROR`, "Reading additional input from
 * stdin...") traced back to one of these.
 *
 * The sweep builds a manager the way production does — the REAL `harnessSpec` + `harnessLineDecoder`
 * — poisons the default kind to codex, and asserts the job the runtime receives NEVER references the
 * codex binary, across every request × fast combination. env.ts's root clamp is asserted separately.
 */
import { describe, it, expect } from "vitest";
import { SessionManager } from "../../src/runtime/manager.js";
import type { ChannelPoster, SessionLogger, SessionStore } from "../../src/runtime/manager.js";
import { harnessSpec, type HarnessKind } from "../../src/runtime/harness.js";
import { harnessLineDecoder } from "../../src/runtime/stream-json.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { loadEnv } from "../../src/env.js";
import type {
  AgentJob,
  AgentRuntime,
  RunningSession,
  RuntimeHooks,
  RuntimeResult,
} from "../../src/runtime/types.js";
import type { AgentSession, ResourceCaps, SessionStatus } from "../../src/db/repositories/agent-sessions.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

class CapturingRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  jobs: AgentJob[] = [];
  start(job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession> {
    this.jobs.push(job);
    hooks.onOutput("stdout", "done\n");
    return Promise.resolve({
      sessionId: job.sessionId,
      wait: () => Promise.resolve<RuntimeResult>({ status: "completed", exitCode: 0 }),
      cancel: () => Promise.resolve(),
    });
  }
}

class RecordingStore implements SessionStore {
  createdHarnesses: Array<string | null> = [];
  private seq = 0;
  create(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    runtime: "local" | "sandbox";
    command: string;
    idempotencyKey?: string | null;
    caps: ResourceCaps;
    harness?: string | null;
  }): Promise<AgentSession> {
    this.seq += 1;
    this.createdHarnesses.push(input.harness ?? null);
    return Promise.resolve({
      id: `sess_${this.seq}`,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentMemberId: input.agentMemberId,
      createdByMemberId: input.createdByMemberId,
      runtime: input.runtime,
      status: "provisioning",
      agentStatus: "idle",
      command: input.command,
      idempotencyKey: input.idempotencyKey ?? null,
      harness: (input.harness ?? null) as AgentSession["harness"],
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
      selectionMeta: null,
      region: null,
      lastHeartbeatAt: null,
      caps: input.caps,
      startedAt: null,
      endedAt: null,
      createdAt: new Date(0),
    });
  }
  markRunning(): Promise<void> {
    return Promise.resolve();
  }
  finalize(_id: string, _f: { status: SessionStatus }): Promise<void> {
    return Promise.resolve();
  }
  forceFinalize(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

const nullPoster: ChannelPoster = {
  post: async () => ({ id: "m1" }),
};

/** A production-shaped manager whose DEFAULT harness is poisoned to codex. */
function poisonedManager(runtime: CapturingRuntime, store: RecordingStore): SessionManager {
  const codexDefault = harnessSpec("codex");
  return new SessionManager({
    runtime,
    store,
    poster: nullPoster,
    secrets: new StaticSecretsResolver({}),
    harness: codexDefault,
    harnessKind: "codex",
    provider: "claude",
    decodeOutput: harnessLineDecoder("codex"),
    // Production wiring: the REAL spec builder for every kind, exactly like runtime/default.ts.
    harnessOverrides: (kind: HarnessKind, opts?: { fast?: boolean }) => ({
      ...harnessSpec(kind, { fast: opts?.fast }),
      decode: harnessLineDecoder(kind),
    }),
    caps: { wallClockMs: 10_000, idleMs: 5_000 },
    logger: silentLogger,
  });
}

const launch = {
  workspaceId: "w1",
  channelId: "c1",
  agentMemberId: "ag1",
  createdByMemberId: "m1",
  task: "research the market",
};

describe("no codex spawn under the claude provider (#1568 regression)", () => {
  it("NEVER hands the runtime a codex command — any request kind × fast, even with a poisoned codex default", async () => {
    const runtime = new CapturingRuntime();
    const store = new RecordingStore();
    const manager = poisonedManager(runtime, store);

    const requests: Array<HarnessKind | undefined> = [undefined, "codex", "claude-code"];
    for (const harness of requests) {
      for (const fast of [undefined, true] as const) {
        const session = await manager.launch({ ...launch, harness, fast });
        await manager.join(session.id);
      }
    }

    expect(runtime.jobs.length).toBe(6);
    for (const job of runtime.jobs) {
      const spawned = JSON.stringify({ command: job.command, args: job.args });
      // The invariant: nothing the runtime executes references the codex CLI in any form.
      expect(spawned).not.toMatch(/codex/i);
      expect(spawned).toContain("claude");
    }
    // And the persisted rows record the CLAMPED kind — a replay/retry of these rows re-clamps to
    // claude-code instead of resurrecting codex.
    expect(new Set(store.createdHarnesses)).toEqual(new Set(["claude-code"]));
  });

  it("env root clamp: a stale explicit AGENT_HARNESS=codex resolves to claude-code on a Claude deployment", () => {
    const agent = loadEnv({ AGENT_HARNESS: "codex" } as NodeJS.ProcessEnv).agent;
    expect(agent.provider).toBe("claude");
    expect(agent.harness).toBe("claude-code");
    // The default spec every no-override launch runs is the CLAUDE spec, not codex.
    expect(JSON.stringify({ command: agent.harnessCommand, args: agent.harnessArgs })).not.toMatch(/codex/i);
  });

  it("env root clamp: AGENT_RUNTIME_PROVIDER=codex keeps an explicit codex harness verbatim (legacy posture)", () => {
    const agent = loadEnv({
      AGENT_HARNESS: "codex",
      AGENT_RUNTIME_PROVIDER: "codex",
    } as NodeJS.ProcessEnv).agent;
    expect(agent.provider).toBe("codex");
    expect(agent.harness).toBe("codex");
    expect(JSON.stringify(agent.harnessArgs)).toMatch(/codex/);
  });
});
