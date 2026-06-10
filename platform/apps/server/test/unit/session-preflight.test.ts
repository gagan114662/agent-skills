import { describe, it, expect } from "vitest";
import { SessionManager } from "../../src/runtime/manager.js";
import type { ChannelPoster, SessionLogger, SessionStore } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { PreflightError, type PreflightReport } from "../../src/runtime/preflight.js";
import type { AgentJob, AgentRuntime, RunningSession, RuntimeHooks } from "../../src/runtime/types.js";

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A store that fails the test if any persistence happens — proves "nothing persisted". */
class ExplodingStore implements SessionStore {
  createCalls = 0;
  create(): Promise<never> {
    this.createCalls += 1;
    return Promise.reject(new Error("store.create must not be called when preflight fails"));
  }
  markRunning(): Promise<void> {
    return Promise.reject(new Error("markRunning must not be called"));
  }
  finalize(): Promise<void> {
    return Promise.reject(new Error("finalize must not be called"));
  }
}

/** A runtime that fails the test if started — proves "no cloud call". */
class ExplodingRuntime implements AgentRuntime {
  readonly kind = "sandbox" as const;
  startCalls = 0;
  start(_job: AgentJob, _hooks: RuntimeHooks): Promise<RunningSession> {
    this.startCalls += 1;
    return Promise.reject(new Error("runtime.start must not be called when preflight fails"));
  }
}

const failingReport: PreflightReport = {
  profile: "prod",
  runtime: "sandbox",
  harness: "claude-code",
  ok: false,
  checks: [
    { name: "vercel-auth", status: "fail", message: "no Vercel auth — set VERCEL_OIDC_TOKEN" },
  ],
};

const poster: ChannelPoster = { post: () => Promise.resolve({ id: "m" }) };

function makeManager(preflightFn: () => PreflightReport, store: ExplodingStore, runtime: ExplodingRuntime) {
  return new SessionManager({
    runtime,
    store,
    poster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: "bash", args: ["x.sh"] },
    caps: { wallClockMs: 10_000, idleMs: 10_000 },
    logger: silentLogger,
    preflight: preflightFn,
  });
}

describe("SessionManager preflight gate (#69 — fail fast, no cloud call, nothing persisted)", () => {
  it("rejects launch with PreflightError when preflight fails — before persisting or touching the runtime", async () => {
    const store = new ExplodingStore();
    const runtime = new ExplodingRuntime();
    const manager = makeManager(() => failingReport, store, runtime);

    await expect(
      manager.launch({
        workspaceId: "ws_1",
        channelId: "ch_1",
        agentMemberId: "mem_agent",
        createdByMemberId: "mem_human",
        task: "do the thing",
      }),
    ).rejects.toBeInstanceOf(PreflightError);

    expect(store.createCalls).toBe(0);
    expect(runtime.startCalls).toBe(0);
  });

  it("the thrown PreflightError carries the actionable report", async () => {
    const manager = makeManager(() => failingReport, new ExplodingStore(), new ExplodingRuntime());
    const err = await manager
      .launch({
        workspaceId: "ws_1",
        channelId: "ch_1",
        agentMemberId: "mem_agent",
        createdByMemberId: "mem_human",
        task: "do the thing",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PreflightError);
    expect((err as PreflightError).report.ok).toBe(false);
  });
});
