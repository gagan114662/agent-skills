import { describe, expect, it } from "vitest";
import { LiveSpendRegistry } from "../../src/scale/live-spend.js";
import { createSpendAnomalyMonitor } from "../../src/scale/spend-anomaly.js";
import type { UsageReader } from "../../src/scale/usage.js";
import type { ResolvedConfig } from "../../src/config/schema.js";

const usage = (estimatedCostCents: number): UsageReader => ({
  async read() {
    return { sessionsStarted: 1, computeSeconds: 60, estimatedCostCents };
  },
});

const config = (budgetCents = 100, rate = 60): ResolvedConfig =>
  ({ scale: { budgetCents, computeRateCentsPerMinute: rate } }) as ResolvedConfig;

const session = {
  sessionId: "sess_1",
  workspaceId: "ws_1",
  channelId: "ch_1",
  agentMemberId: "agent_1",
  createdByMemberId: "owner_1",
  task: "do work",
  startedAtMs: 0,
};

describe("spend anomaly monitor (#926)", () => {
  it("alerts at budget utilization thresholds and exposes live session spend", async () => {
    const registry = new LiveSpendRegistry();
    const alerts: number[] = [];
    const monitor = createSpendAnomalyMonitor({
      usage: usage(40),
      config: () => config(),
      registry,
      onAlert: async (a) => void alerts.push(a.threshold),
    });

    const guard = await monitor.begin(session);
    expect(guard).not.toBeNull();
    const check = await guard!.check(10); // 10c session cost + 40c existing = 50%

    expect(check.alerts).toEqual([50]);
    expect(check.kill).toBe(false);
    expect(registry.list("ws_1")[0]).toMatchObject({
      sessionId: "sess_1",
      estimatedCostCents: 10,
      threshold: 50,
    });
    expect(alerts).toEqual([50]);
    guard!.close();
    expect(registry.list("ws_1")).toEqual([]);
  });

  it("kills a session once it would burn at least half the remaining budget", async () => {
    const kills: string[] = [];
    const monitor = createSpendAnomalyMonitor({
      usage: usage(80),
      config: () => config(),
      onKill: async (k) => void kills.push(k.reason),
    });

    const guard = await monitor.begin(session);
    const check = await guard!.check(10); // remaining was 20c; this one session hits half of that.

    expect(check.kill).toBe(true);
    expect(check.reason).toBe("session_spend_exceeded_half_remaining_budget");
    expect(kills).toEqual(["session_spend_exceeded_half_remaining_budget"]);
  });

  it("stays disabled when there is no positive budget or compute rate", async () => {
    const monitor = createSpendAnomalyMonitor({
      usage: usage(0),
      config: () => config(0, 60),
    });
    await expect(monitor.begin(session)).resolves.toBeNull();
  });
});
