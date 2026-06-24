import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderMetrics, resetMetrics } from "../../src/observability/metrics.js";
import { WATCHDOG_DEFAULTS, type WatchdogCaps } from "../../src/watchdog/caps.js";
import {
  WatchdogEngine,
  type LiveSession,
  type RevivalRecord,
  type WatchdogEngineDeps,
} from "../../src/watchdog/engine.js";

const silentLogger = {
  child() {
    return silentLogger;
  },
  info() {},
  warn() {},
  error() {},
};

const NOW = new Date("2026-06-10T00:00:00Z");

function liveSession(over: Partial<LiveSession> = {}): LiveSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    channelId: "chan_1",
    agentMemberId: "agent_1",
    createdByMemberId: "agent_1",
    status: "running",
    // 10m of no progress, well past the default 5m stale cutoff
    progressAt: new Date(NOW.getTime() - 600_000),
    ...over,
  };
}

function record(over: Partial<RevivalRecord> = {}): RevivalRecord {
  return {
    id: "rev_1",
    workspaceId: "ws_1",
    rootSessionId: "sess_1",
    currentSessionId: "sess_1",
    revivals: 0,
    windowStartedAt: NOW,
    lastRevivalAt: null,
    lastErrorClass: "stalled",
    status: "active",
    ...over,
  };
}

/** Build the engine over fakes; override any seam per test. Enabled caps by default. */
function build(over: Partial<WatchdogEngineDeps> = {}, caps: WatchdogCaps = { ...WATCHDOG_DEFAULTS, enabled: true }) {
  const reviver = { launch: vi.fn(async () => ({ id: "sess_2" })) };
  const escalator = { escalate: vi.fn(async () => ({ id: "appr_1" })) };
  const finalizeDead = vi.fn(async () => {});
  const revivals = {
    getByCurrentSession: vi.fn(async (): Promise<RevivalRecord | null> => null),
    createForRoot: vi.fn(async () => record()),
    recordRevival: vi.fn(async () => record({ revivals: 1, currentSessionId: "sess_2" })),
    markEscalated: vi.fn(async () => {}),
  };
  const deps: WatchdogEngineDeps = {
    listLiveSessions: vi.fn(async () => [liveSession()]),
    caps: () => caps,
    killSwitch: vi.fn(async () => false),
    budgetExhausted: vi.fn(async () => false),
    revivals,
    reviver,
    finalizeDead,
    escalator,
    maintenancePaused: vi.fn(async () => false),
    logger: silentLogger,
    now: () => NOW,
    ...over,
  };
  const engine = new WatchdogEngine(deps);
  // Return the EFFECTIVE seams the engine uses (an `over` may replace `revivals`/etc.), so assertions
  // target what the engine actually called.
  return {
    engine,
    deps,
    reviver: deps.reviver as typeof reviver,
    escalator: deps.escalator as typeof escalator,
    finalizeDead: deps.finalizeDead as typeof finalizeDead,
    revivals: deps.revivals as typeof revivals,
  };
}

describe("WatchdogEngine", () => {
  beforeEach(() => resetMetrics());

  it("skips the whole pass during maintenance — BEFORE listing any sessions", async () => {
    const listLiveSessions = vi.fn(async () => [liveSession()]);
    const { engine } = build({ maintenancePaused: async () => true, listLiveSessions });
    await engine.tickAll();
    expect(listLiveSessions).not.toHaveBeenCalled();
  });

  it("logs and counts a top-level tickAll failure without throwing", async () => {
    const logger = { ...silentLogger, error: vi.fn() };
    const { engine } = build({
      logger,
      listLiveSessions: vi.fn(async () => {
        throw new Error("db unavailable");
      }),
    });

    await expect(engine.tickAll()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), "watchdog tickAll failed");
    expect(renderMetrics()).toContain('loop_tick_failures_total{loop="watchdog"} 1');
  });

  it("skips a workspace whose kill switch is engaged — no revive, no escalate", async () => {
    const { engine, reviver, escalator, killSwitch } = (() => {
      const b = build({ killSwitch: vi.fn(async () => true) });
      return { ...b, killSwitch: b.deps.killSwitch };
    })();
    const result = await engine.tickWorkspace("ws_1", [liveSession()], NOW);
    expect(result.skipped).toBe("kill_switch");
    expect(reviver.launch).not.toHaveBeenCalled();
    expect(escalator.escalate).not.toHaveBeenCalled();
    expect(killSwitch).toHaveBeenCalledWith("ws_1");
  });

  it("does nothing when the watchdog is disabled in config (default OFF)", async () => {
    const { engine, reviver, escalator } = build({}, { ...WATCHDOG_DEFAULTS, enabled: false });
    const result = await engine.tickWorkspace("ws_1", [liveSession()], NOW);
    expect(result.skipped).toBe("disabled");
    expect(reviver.launch).not.toHaveBeenCalled();
    expect(escalator.escalate).not.toHaveBeenCalled();
  });

  it("revives a stale session: finalizes the dead row, launches a replacement, records the revival", async () => {
    const { engine, reviver, finalizeDead, revivals } = build();
    const result = await engine.tickWorkspace("ws_1", [liveSession()], NOW);

    expect(finalizeDead).toHaveBeenCalledWith("sess_1", "failed");
    expect(reviver.launch).toHaveBeenCalledTimes(1);
    const launchArg = reviver.launch.mock.calls[0][0];
    expect(launchArg).toMatchObject({ workspaceId: "ws_1", channelId: "chan_1", agentMemberId: "agent_1" });
    expect(revivals.recordRevival).toHaveBeenCalledTimes(1);
    expect(result.actions).toEqual([{ sessionId: "sess_1", action: "revive", reason: "stale_session" }]);
  });

  it("escalates instead of reviving once the per-window limit is reached", async () => {
    const atLimit = record({ revivals: 3, currentSessionId: "sess_1", windowStartedAt: NOW });
    const { engine, reviver, escalator, revivals } = build({
      revivals: {
        getByCurrentSession: vi.fn(async () => atLimit),
        createForRoot: vi.fn(async () => atLimit),
        recordRevival: vi.fn(async () => atLimit),
        markEscalated: vi.fn(async () => {}),
      },
    });
    const result = await engine.tickWorkspace("ws_1", [liveSession()], NOW);

    expect(reviver.launch).not.toHaveBeenCalled();
    expect(escalator.escalate).toHaveBeenCalledTimes(1);
    expect(revivals.markEscalated).toHaveBeenCalledWith("rev_1");
    expect(result.actions[0]).toMatchObject({ action: "escalate", reason: "revival_limit" });
  });

  it("waits (no revive, no escalate) while inside the backoff window", async () => {
    const recent = record({ revivals: 1, lastRevivalAt: new Date(NOW.getTime() - 5_000) });
    const { engine, reviver, escalator } = build({
      revivals: {
        getByCurrentSession: vi.fn(async () => recent),
        createForRoot: vi.fn(async () => recent),
        recordRevival: vi.fn(async () => recent),
        markEscalated: vi.fn(async () => {}),
      },
    });
    const result = await engine.tickWorkspace("ws_1", [liveSession()], NOW);
    expect(reviver.launch).not.toHaveBeenCalled();
    expect(escalator.escalate).not.toHaveBeenCalled();
    expect(result.actions[0]).toMatchObject({ action: "wait", reason: "backoff" });
  });

  it("escalates a non-retryable failure (a human cancel) without reviving", async () => {
    const { engine, reviver, escalator } = build({
      listLiveSessions: vi.fn(async () => [liveSession({ status: "canceled" })]),
    });
    const result = await engine.tickWorkspace("ws_1", [liveSession({ status: "canceled" })], NOW);
    expect(reviver.launch).not.toHaveBeenCalled();
    expect(escalator.escalate).toHaveBeenCalledTimes(1);
    expect(result.actions[0]).toMatchObject({ action: "escalate", reason: "non_retryable_failure" });
  });

  it("isolates workspaces: A's stale session never drives action in B", async () => {
    const caps = (wid: string): WatchdogCaps =>
      wid === "ws_A" ? { ...WATCHDOG_DEFAULTS, enabled: true } : { ...WATCHDOG_DEFAULTS, enabled: false };
    const { engine, reviver } = build({
      listLiveSessions: vi.fn(async () => [
        liveSession({ id: "a1", workspaceId: "ws_A" }),
        liveSession({ id: "b1", workspaceId: "ws_B" }),
      ]),
      caps,
    });
    await engine.tickAll();
    // Only ws_A is enabled, so exactly one revive (its own session) — ws_B is untouched.
    expect(reviver.launch).toHaveBeenCalledTimes(1);
    expect(reviver.launch.mock.calls[0][0]).toMatchObject({ workspaceId: "ws_A" });
  });

  it("start() is a no-op at interval 0 (default OFF)", () => {
    const { engine, deps } = build();
    engine.start(0);
    expect(deps.listLiveSessions).not.toHaveBeenCalled();
    engine.stop();
  });
});
