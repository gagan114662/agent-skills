import { describe, it, expect } from "vitest";
import {
  KillSwitchService,
  type KillSwitchAlert,
  type KillSwitchAlertSink,
} from "../../src/kill-switch/service.js";
import { InMemoryKillSwitchStore } from "../../src/kill-switch/store.js";
import type { KillSwitchCaps } from "../../src/kill-switch/caps.js";
import type { GuardMetrics } from "../../src/kill-switch/tripwire.js";

/**
 * #592 acceptance: "a simulated spend spike pauses agents within one cycle and notifies the user."
 *
 * Models the fleet as a set of agents that consult `isFleetPaused()` before acting (the #71 admission
 * chokepoint seam) and proves that ONE evaluate() cycle on a spend spike flips every agent to paused AND
 * delivers the user alert.
 */

const CAPS: KillSwitchCaps = {
  enabled: true,
  thresholds: { maxSpendPerHourCents: 20_000, maxErrorRateBps: 2_000, maxBounceRateBps: 3_000 },
};

class RecordingSink implements KillSwitchAlertSink {
  events: KillSwitchAlert[] = [];
  async alert(event: KillSwitchAlert): Promise<void> {
    this.events.push(event);
  }
}

/** A fleet agent that only acts when the switch says the fleet is running. */
async function agentMayAct(service: KillSwitchService): Promise<boolean> {
  return !(await service.isFleetPaused());
}

describe("#592 acceptance — dead-man's switch on a spend spike", () => {
  it("pauses ALL agents within one cycle and notifies the user", async () => {
    const sink = new RecordingSink();
    const service = new KillSwitchService({
      store: new InMemoryKillSwitchStore(),
      alertSink: sink,
      caps: CAPS,
      now: () => new Date(1_000),
    });

    // Before the spike: the fleet is running — agents may act.
    expect(await agentMayAct(service)).toBe(true);

    // One monitoring cycle observes a 5x spend spike ($500/hr vs the $200/hr ceiling).
    const spike: GuardMetrics = { spendPerHourCents: 100_000, errorRateBps: 100, bounceRateBps: 100 };
    const result = await service.evaluate(spike);

    // ...within that SAME cycle the switch tripped and the fleet is paused.
    expect(result.tripped).toBe(true);
    expect(result.paused).toBe(true);

    // Every agent is now blocked from acting.
    const fleet = await Promise.all([agentMayAct(service), agentMayAct(service), agentMayAct(service)]);
    expect(fleet).toEqual([false, false, false]);

    // ...and the user was notified in that cycle.
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.kind).toBe("engaged");
    expect(sink.events[0]?.source).toBe("tripwire");
    expect(sink.events[0]?.message).toContain("ALL agents paused");
    expect(sink.events[0]?.breaches[0]?.metric).toBe("spend_per_hour");
  });

  it("a KPI crater (error-rate breach) also pauses the fleet and notifies", async () => {
    const sink = new RecordingSink();
    const service = new KillSwitchService({
      store: new InMemoryKillSwitchStore(),
      alertSink: sink,
      caps: CAPS,
      now: () => new Date(1_000),
    });

    const crater: GuardMetrics = { spendPerHourCents: 500, errorRateBps: 8_000, bounceRateBps: 100 };
    const result = await service.evaluate(crater);

    expect(result.paused).toBe(true);
    expect(await agentMayAct(service)).toBe(false);
    expect(sink.events[0]?.breaches[0]?.metric).toBe("error_rate");
  });
});
