import { describe, it, expect, beforeEach } from "vitest";
import {
  KillSwitchService,
  KillSwitchError,
  type KillSwitchAlert,
  type KillSwitchAlertSink,
} from "../../src/kill-switch/service.js";
import { InMemoryKillSwitchStore } from "../../src/kill-switch/store.js";
import type { KillSwitchCaps } from "../../src/kill-switch/caps.js";
import type { GuardMetrics } from "../../src/kill-switch/tripwire.js";

const ENABLED: KillSwitchCaps = {
  enabled: true,
  thresholds: { maxSpendPerHourCents: 10_000, maxErrorRateBps: 2_000, maxBounceRateBps: 3_000 },
};
const DISABLED: KillSwitchCaps = { enabled: false, thresholds: ENABLED.thresholds };

const HEALTHY: GuardMetrics = { spendPerHourCents: 1_000, errorRateBps: 100, bounceRateBps: 200 };
const SPIKE: GuardMetrics = { spendPerHourCents: 50_000, errorRateBps: 100, bounceRateBps: 200 };

class RecordingSink implements KillSwitchAlertSink {
  events: KillSwitchAlert[] = [];
  async alert(event: KillSwitchAlert): Promise<void> {
    this.events.push(event);
  }
}

function makeService(caps: KillSwitchCaps, sink: KillSwitchAlertSink = new RecordingSink()) {
  const store = new InMemoryKillSwitchStore();
  const service = new KillSwitchService({ store, alertSink: sink, caps, now: () => new Date(1_000) });
  return { store, service, sink };
}

describe("KillSwitchService — disabled (default)", () => {
  it("is inert: never trips, never reports the fleet paused", async () => {
    const { service } = makeService(DISABLED);
    const res = await service.evaluate(SPIKE);
    expect(res.tripped).toBe(false);
    expect(res.paused).toBe(false);
    expect(await service.isFleetPaused()).toBe(false);
  });

  it("refuses a manual engage while disabled", async () => {
    const { service } = makeService(DISABLED);
    await expect(service.engage({ reason: "halt", byMemberId: "owner" })).rejects.toBeInstanceOf(
      KillSwitchError,
    );
  });
});

describe("KillSwitchService — tripwire auto-engage", () => {
  let sink: RecordingSink;
  let service: KillSwitchService;

  beforeEach(() => {
    sink = new RecordingSink();
    ({ service } = makeService(ENABLED, sink));
  });

  it("stays armed while metrics are healthy", async () => {
    const res = await service.evaluate(HEALTHY);
    expect(res.tripped).toBe(false);
    expect(res.paused).toBe(false);
    expect(await service.isFleetPaused()).toBe(false);
    expect(sink.events).toHaveLength(0);
  });

  it("engages and alerts the same cycle a tripwire breaches", async () => {
    const res = await service.evaluate(SPIKE);
    expect(res.tripped).toBe(true);
    expect(res.paused).toBe(true);
    expect(await service.isFleetPaused()).toBe(true);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.kind).toBe("engaged");
    expect(sink.events[0]?.source).toBe("tripwire");
    expect(sink.events[0]?.breaches[0]?.metric).toBe("spend_per_hour");
  });

  it("does not re-engage or re-alert on later cycles while already tripped", async () => {
    await service.evaluate(SPIKE);
    const second = await service.evaluate(SPIKE);
    expect(second.tripped).toBe(false); // no NEW transition
    expect(second.paused).toBe(true); // but still halted
    expect(sink.events).toHaveLength(1); // alerted exactly once
  });

  it("records the engagement and the breaches in the status report", async () => {
    await service.evaluate(SPIKE);
    const status = await service.status();
    expect(status.paused).toBe(true);
    expect(status.source).toBe("tripwire");
    expect(status.engagedAt).toEqual(new Date(1_000));
    expect(status.breaches.map((b) => b.metric)).toContain("spend_per_hour");
  });

  it("writes an audit-log entry for the auto-engage", async () => {
    await service.evaluate(SPIKE);
    const history = await service.history();
    expect(history).toHaveLength(1);
    expect(history[0]?.action).toBe("engage");
    expect(history[0]?.source).toBe("tripwire");
  });

  it("stays paused even after metrics recover — only a recorded human resumes it", async () => {
    await service.evaluate(SPIKE);
    const afterRecovery = await service.evaluate(HEALTHY);
    expect(afterRecovery.paused).toBe(true);
    expect(await service.isFleetPaused()).toBe(true);
  });
});

describe("KillSwitchService — manual global kill", () => {
  it("engages immediately, halting the fleet, and alerts", async () => {
    const { service, sink } = makeService(ENABLED);
    const recordingSink = sink as RecordingSink;
    const { event, status } = await service.engage({ reason: "runaway loop", byMemberId: "owner" });
    expect(status.paused).toBe(true);
    expect(status.source).toBe("manual");
    expect(status.engagedByMemberId).toBe("owner");
    expect(event?.action).toBe("engage");
    expect(await service.isFleetPaused()).toBe(true);
    expect(recordingSink.events[0]?.message).toContain("ENGAGED");
  });

  it("is idempotent — a second engage is a no-op (no duplicate alert / audit row)", async () => {
    const { service, sink } = makeService(ENABLED);
    const recordingSink = sink as RecordingSink;
    await service.engage({ reason: "halt", byMemberId: "owner" });
    const again = await service.engage({ reason: "halt again", byMemberId: "owner2" });
    expect(again.event).toBeNull();
    expect(recordingSink.events).toHaveLength(1);
    expect(await service.history()).toHaveLength(1);
  });

  it("falls back to a default reason when an empty reason is given", async () => {
    const { service } = makeService(ENABLED);
    const { status } = await service.engage({ reason: "   ", byMemberId: "owner" });
    expect(status.engagedReason).toBe("manual global kill-switch");
  });
});

describe("KillSwitchService — disengage (recorded human resume)", () => {
  it("resumes an engaged fleet, records the actor, and alerts a resume", async () => {
    const { service, sink } = makeService(ENABLED);
    const recordingSink = sink as RecordingSink;
    await service.engage({ reason: "halt", byMemberId: "owner" });
    const { status, event } = await service.disengage({ byMemberId: "owner", reason: "fixed" });
    expect(status.paused).toBe(false);
    expect(status.status).toBe("armed");
    expect(event?.action).toBe("disengage");
    expect(event?.actorMemberId).toBe("owner");
    expect(await service.isFleetPaused()).toBe(false);
    expect(recordingSink.events.some((e) => e.kind === "resumed")).toBe(true);
  });

  it("throws when there is nothing to resume", async () => {
    const { service } = makeService(ENABLED);
    await expect(service.disengage({ byMemberId: "owner" })).rejects.toBeInstanceOf(KillSwitchError);
  });

  it("a tripwire can re-engage after a resume (the high-water mark resets)", async () => {
    const { service, sink } = makeService(ENABLED);
    const recordingSink = sink as RecordingSink;
    await service.evaluate(SPIKE); // auto-engage #1
    await service.disengage({ byMemberId: "owner", reason: "investigated" });
    const re = await service.evaluate(SPIKE); // auto-engage #2
    expect(re.tripped).toBe(true);
    expect(recordingSink.events.filter((e) => e.kind === "engaged")).toHaveLength(2);
  });
});

describe("KillSwitchService — alert failures never unpause the fleet", () => {
  it("keeps the fleet halted even if the alert sink throws", async () => {
    const throwingSink: KillSwitchAlertSink = {
      async alert() {
        throw new Error("pager down");
      },
    };
    const { service } = makeService(ENABLED, throwingSink);
    const res = await service.evaluate(SPIKE);
    expect(res.paused).toBe(true);
    expect(await service.isFleetPaused()).toBe(true);
  });
});
