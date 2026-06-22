import { describe, it, expect, beforeEach } from "vitest";
import {
  BudgetGovernorService,
  BudgetGovernorError,
  type AlertEvent,
  type AlertSink,
} from "../../src/budget/service.js";
import { InMemoryBudgetStore } from "../../src/budget/store.js";
import type { BudgetGovernorCaps } from "../../src/budget/caps.js";

const ENABLED: BudgetGovernorCaps = { enabled: true, alertThresholdBps: 8_000 };
const DISABLED: BudgetGovernorCaps = { enabled: false, alertThresholdBps: 8_000 };
const WID = "ws-1";

class RecordingSink implements AlertSink {
  events: AlertEvent[] = [];
  async alert(event: AlertEvent): Promise<void> {
    this.events.push(event);
  }
}

function makeService(caps: BudgetGovernorCaps, sink: AlertSink = new RecordingSink()) {
  const store = new InMemoryBudgetStore({ now: () => new Date(1_000) });
  const service = new BudgetGovernorService({ store, alertSink: sink, caps, now: () => new Date(2_000) });
  return { store, service, sink };
}

/** Seed a workspace cap by approving an initial raise (the only way the ceiling rises). */
async function seedCap(service: BudgetGovernorService, cents: number): Promise<void> {
  const raise = await service.requestRaise(WID, "owner", cents);
  await service.approveRaise(WID, raise.id, "owner");
}

describe("BudgetGovernorService — disabled (default)", () => {
  it("allows every spend and reserves nothing when disabled", async () => {
    const { service, store } = makeService(DISABLED);
    const res = await service.authorizeSpend(WID, 999_999);
    expect(res.allowed).toBe(true);
    expect((await store.getRecord(WID)).projectedCents).toBe(0);
  });
});

describe("BudgetGovernorService — enforcement", () => {
  let sink: RecordingSink;
  let service: BudgetGovernorService;

  beforeEach(async () => {
    sink = new RecordingSink();
    ({ service } = makeService(ENABLED, sink));
    await seedCap(service, 10_000);
  });

  it("allows and reserves a spend within the cap", async () => {
    const res = await service.authorizeSpend(WID, 4_000);
    expect(res.allowed).toBe(true);
    const status = await service.status(WID);
    expect(status.projectedCents).toBe(4_000);
    expect(status.availableCents).toBe(6_000);
  });

  it("HALTS a spend that would exceed the cap and alerts the user", async () => {
    await service.authorizeSpend(WID, 9_000); // 90% reserved → also crosses the 80% alert line
    const res = await service.authorizeSpend(WID, 5_000); // would exceed
    expect(res.allowed).toBe(false);
    expect(res.requiresApproval).toBe(true);
    expect(sink.events.some((e) => e.kind === "halt")).toBe(true);
  });

  it("alerts once when utilization crosses the threshold, not on every spend", async () => {
    await service.authorizeSpend(WID, 8_500); // crosses 80%
    await service.authorizeSpend(WID, 100); // still above, no NEW crossing
    const thresholdAlerts = sink.events.filter((e) => e.kind === "threshold");
    expect(thresholdAlerts.length).toBe(1);
  });

  it("settle moves a reservation into committed", async () => {
    await service.authorizeSpend(WID, 3_000);
    await service.settle(WID, 3_000, 2_500);
    const status = await service.status(WID);
    expect(status.committedCents).toBe(2_500);
    expect(status.projectedCents).toBe(0);
  });

  it("release frees a reservation", async () => {
    await service.authorizeSpend(WID, 3_000);
    await service.release(WID, 3_000);
    expect((await service.status(WID)).projectedCents).toBe(0);
  });
});

describe("BudgetGovernorService — cap raises require recorded human approval", () => {
  it("a fresh workspace has a zero cap and halts all positive spend until a cap is approved", async () => {
    const { service } = makeService(ENABLED);
    const res = await service.authorizeSpend(WID, 100);
    expect(res.allowed).toBe(false);
  });

  it("requestRaise parks a pending raise that does NOT change the cap", async () => {
    const { service } = makeService(ENABLED);
    const raise = await service.requestRaise(WID, "owner", 10_000);
    expect(raise.status).toBe("pending");
    expect((await service.status(WID)).capCents).toBe(0);
  });

  it("approveRaise applies the new ceiling and records the approver", async () => {
    const { service } = makeService(ENABLED);
    const raise = await service.requestRaise(WID, "owner", 10_000);
    const { raise: decided, status } = await service.approveRaise(WID, raise.id, "owner", "ok");
    expect(decided.status).toBe("approved");
    expect(decided.decidedByMemberId).toBe("owner");
    expect(status.capCents).toBe(10_000);
  });

  it("rejectRaise leaves the cap unchanged", async () => {
    const { service } = makeService(ENABLED);
    await seedCap(service, 10_000);
    const raise = await service.requestRaise(WID, "owner", 50_000);
    const { status } = await service.rejectRaise(WID, raise.id, "owner", "too high");
    expect(status.capCents).toBe(10_000);
  });

  it("rejects a raise that is not strictly above the current cap", async () => {
    const { service } = makeService(ENABLED);
    await seedCap(service, 10_000);
    await expect(service.requestRaise(WID, "owner", 10_000)).rejects.toBeInstanceOf(BudgetGovernorError);
  });

  it("cannot approve the same raise twice", async () => {
    const { service } = makeService(ENABLED);
    const raise = await service.requestRaise(WID, "owner", 10_000);
    await service.approveRaise(WID, raise.id, "owner");
    await expect(service.approveRaise(WID, raise.id, "owner")).rejects.toBeInstanceOf(BudgetGovernorError);
  });

  it("lowerCap tightens immediately without approval", async () => {
    const { service } = makeService(ENABLED);
    await seedCap(service, 10_000);
    await service.lowerCap(WID, 4_000);
    expect((await service.status(WID)).capCents).toBe(4_000);
  });

  it("scopes raises to their workspace (#3 IDOR)", async () => {
    const { service } = makeService(ENABLED);
    const raise = await service.requestRaise(WID, "owner", 10_000);
    await expect(service.approveRaise("other-ws", raise.id, "attacker")).rejects.toBeInstanceOf(
      BudgetGovernorError,
    );
  });
});
