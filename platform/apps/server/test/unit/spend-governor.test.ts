import { describe, it, expect } from "vitest";
import {
  channelSpendStatus,
  decideSpend,
  periodKeyFor,
  rollPeriod,
  validateRaise,
  applyReserve,
  applySettle,
  applyRelease,
  applyLowerCap,
  applyRaiseCap,
  type ChannelSpendState,
} from "../../src/spend-governor/governor.js";
import {
  SpendGovernorService,
  SpendGovernorError,
  InMemoryChannelStore,
  type AlertEvent,
  type SpendGovernorCaps,
} from "../../src/spend-governor/index.js";

const state = (capCents: number, committedCents: number, projectedCents: number, periodKey = 0): ChannelSpendState => ({
  capCents,
  committedCents,
  projectedCents,
  periodKey,
});

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

describe("spend governor core — channelSpendStatus", () => {
  it("reports headroom, utilization and not-blocked below the cap", () => {
    const s = channelSpendStatus(state(10_000, 3_000, 1_000), 8_000);
    expect(s.totalCents).toBe(4_000);
    expect(s.availableCents).toBe(6_000);
    expect(s.utilizationBps).toBe(4_000);
    expect(s.blocked).toBe(false);
    expect(s.alerting).toBe(false);
  });

  it("alerts once utilization reaches the threshold", () => {
    const s = channelSpendStatus(state(10_000, 8_000, 500), 8_000);
    expect(s.utilizationBps).toBe(8_500);
    expect(s.alerting).toBe(true);
    expect(s.blocked).toBe(false);
  });

  it("is blocked (and fully utilized) once committed+projected reach the cap", () => {
    const s = channelSpendStatus(state(10_000, 7_000, 3_000), 8_000);
    expect(s.availableCents).toBe(0);
    expect(s.utilizationBps).toBe(10_000);
    expect(s.blocked).toBe(true);
  });

  it("fail-closed: a non-finite cap blocks everything; counters never manufacture headroom", () => {
    expect(channelSpendStatus(state(Number.NaN, 0, 0)).blocked).toBe(true);
    expect(channelSpendStatus(state(-1, 0, 0)).blocked).toBe(true);
    // negative counter clamps to 0, non-finite counter clamps UP to the cap
    expect(channelSpendStatus(state(10_000, -500, 0)).availableCents).toBe(10_000);
    expect(channelSpendStatus(state(10_000, Number.POSITIVE_INFINITY, 0)).availableCents).toBe(0);
  });
});

describe("spend governor core — decideSpend (under-cap allowed / over-cap blocked)", () => {
  it("allows a spend that fits inside the remaining headroom", () => {
    const d = decideSpend(state(10_000, 4_000, 1_000), 3_000);
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
    expect(d.overByCents).toBe(0);
  });

  it("allows spending the exact remaining headroom", () => {
    const d = decideSpend(state(10_000, 6_000, 1_000), 3_000);
    expect(d.allowed).toBe(true);
    expect(d.availableCents).toBe(3_000);
  });

  it("BLOCKS a spend that would exceed the cap and demands approval", () => {
    const d = decideSpend(state(10_000, 6_000, 1_000), 5_000);
    expect(d.allowed).toBe(false);
    expect(d.requiresApproval).toBe(true);
    expect(d.availableCents).toBe(3_000);
    expect(d.overByCents).toBe(2_000);
  });

  it("treats a non-positive request as a no-op, and an indeterminate request as approval-required", () => {
    expect(decideSpend(state(10_000, 0, 0), 0).allowed).toBe(true);
    expect(decideSpend(state(10_000, 0, 0), -5).allowed).toBe(true);
    const nan = decideSpend(state(10_000, 0, 0), Number.NaN);
    expect(nan.allowed).toBe(false);
    expect(nan.requiresApproval).toBe(true);
  });
});

describe("spend governor core — period reset", () => {
  it("buckets instants into stable period keys that advance only at a boundary", () => {
    const day = 24 * 60 * 60 * 1_000;
    expect(periodKeyFor(0, day)).toBe(0);
    expect(periodKeyFor(day - 1, day)).toBe(0);
    expect(periodKeyFor(day, day)).toBe(1);
    expect(periodKeyFor(day * 3 + 5, day)).toBe(3);
    // degenerate period collapses to a single bucket
    expect(periodKeyFor(99, 0)).toBe(0);
    expect(periodKeyFor(Number.NaN, day)).toBe(0);
  });

  it("resets committed+projected to 0 when the period rolls but carries the cap forward", () => {
    const prev = state(10_000, 9_000, 500, 0);
    const rolled = rollPeriod(prev, 1);
    expect(rolled.committedCents).toBe(0);
    expect(rolled.projectedCents).toBe(0);
    expect(rolled.capCents).toBe(10_000);
    expect(rolled.periodKey).toBe(1);
  });

  it("leaves the state untouched within the same period", () => {
    const prev = state(10_000, 9_000, 500, 7);
    expect(rollPeriod(prev, 7)).toBe(prev);
  });
});

describe("spend governor core — validateRaise + transitions", () => {
  it("accepts a strict increase and rejects equal/lower targets", () => {
    expect(validateRaise(10_000, 12_000).ok).toBe(true);
    expect(validateRaise(10_000, 10_000).ok).toBe(false);
    expect(validateRaise(10_000, 9_000).ok).toBe(false);
    expect(validateRaise(10_000, -1).ok).toBe(false);
    expect(validateRaise(10_000, Number.NaN).ok).toBe(false);
  });

  it("reserve / settle / release move money between projected and committed without going negative", () => {
    let s: ChannelSpendState = state(10_000, 0, 0);
    s = applyReserve(s, 3_000);
    expect(s.projectedCents).toBe(3_000);
    s = applySettle(s, 3_000, 2_500);
    expect(s.projectedCents).toBe(0);
    expect(s.committedCents).toBe(2_500);
    s = applyReserve(s, 1_000);
    s = applyRelease(s, 5_000); // over-release clamps at 0
    expect(s.projectedCents).toBe(0);
  });

  it("lower/raise cap only change the ceiling", () => {
    expect(applyLowerCap(state(10_000, 0, 0), 5_000).capCents).toBe(5_000);
    expect(applyRaiseCap(state(10_000, 0, 0), 20_000).capCents).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const WS = "ws-1";
const ENABLED: SpendGovernorCaps = { enabled: true, periodMs: 24 * 60 * 60 * 1_000, alertThresholdBps: 8_000 };

function build(opts: { enabled?: boolean; nowMs?: () => number } = {}) {
  const alerts: AlertEvent[] = [];
  const store = new InMemoryChannelStore();
  let clock = opts.nowMs ?? (() => 0);
  const svc = new SpendGovernorService({
    store,
    alertSink: { alert: async (e) => void alerts.push(e) },
    caps: { ...ENABLED, enabled: opts.enabled ?? true },
    now: () => new Date(clock()),
  });
  return { svc, store, alerts, setClock: (fn: () => number) => { clock = fn; } };
}

describe("SpendGovernorService — under-cap allowed", () => {
  it("reserves and allows a spend within the channel cap", async () => {
    const { svc } = build();
    await svc.lowerCap(WS, "ads", 10_000);
    const r = await svc.authorizeSpend(WS, "ads", 3_000);
    expect(r.allowed).toBe(true);
    expect(r.requiresApproval).toBe(false);
    expect(r.status.projectedCents).toBe(3_000);
    expect(r.status.availableCents).toBe(7_000);
  });

  it("keeps per-channel caps independent (ads spend does not touch email headroom)", async () => {
    const { svc } = build();
    await svc.lowerCap(WS, "ads", 5_000);
    await svc.lowerCap(WS, "email", 5_000);
    await svc.authorizeSpend(WS, "ads", 5_000); // exhaust ads
    const email = await svc.authorizeSpend(WS, "email", 4_000);
    expect(email.allowed).toBe(true);
    const statuses = await svc.statuses(WS);
    expect(statuses.find((s) => s.channel === "ads")?.blocked).toBe(true);
    expect(statuses.find((s) => s.channel === "email")?.availableCents).toBe(1_000);
  });
});

describe("SpendGovernorService — over-cap blocked (the money gate)", () => {
  it("blocks a spend that would exceed the cap, reserves nothing, and alerts", async () => {
    const { svc, alerts } = build();
    await svc.lowerCap(WS, "ads", 10_000);
    await svc.authorizeSpend(WS, "ads", 8_000);
    const blocked = await svc.authorizeSpend(WS, "ads", 5_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.requiresApproval).toBe(true);
    // projected unchanged — the over-cap request reserved nothing
    expect((await svc.status(WS, "ads")).projectedCents).toBe(8_000);
    expect(alerts.some((a) => a.kind === "blocked")).toBe(true);
  });

  it("never lets committed+projected exceed the cap across many requests", async () => {
    const { svc } = build();
    await svc.lowerCap(WS, "ads", 1_000);
    for (let i = 0; i < 20; i++) await svc.authorizeSpend(WS, "ads", 300);
    const s = await svc.status(WS, "ads");
    expect(s.totalCents).toBeLessThanOrEqual(1_000);
  });
});

describe("SpendGovernorService — disabled is inert", () => {
  it("allows everything and reserves nothing when the master switch is OFF", async () => {
    const { svc } = build({ enabled: false });
    await svc.lowerCap(WS, "ads", 1_000);
    const r = await svc.authorizeSpend(WS, "ads", 999_999);
    expect(r.allowed).toBe(true);
    expect((await svc.status(WS, "ads")).projectedCents).toBe(0);
  });
});

describe("SpendGovernorService — period reset refills the cap", () => {
  it("a blocked channel becomes spendable again in the next period", async () => {
    const day = 24 * 60 * 60 * 1_000;
    let t = 0;
    const { svc, setClock } = build({ nowMs: () => t });
    setClock(() => t);

    await svc.lowerCap(WS, "ads", 10_000);
    await svc.authorizeSpend(WS, "ads", 10_000); // exhaust this period
    expect((await svc.authorizeSpend(WS, "ads", 1_000)).allowed).toBe(false);

    t = day + 1; // roll into the next period
    const after = await svc.authorizeSpend(WS, "ads", 6_000);
    expect(after.allowed).toBe(true);
    expect(after.status.committedCents).toBe(0); // last period's committed/projected reset
    expect(after.status.projectedCents).toBe(6_000);
    expect(after.status.capCents).toBe(10_000); // cap carried forward
  });
});

describe("SpendGovernorService — approval-gated override", () => {
  it("requires a recorded human approval to raise a cap; the raise then unblocks the spend", async () => {
    const { svc } = build();
    await svc.lowerCap(WS, "ads", 10_000);
    await svc.authorizeSpend(WS, "ads", 10_000); // at the cap
    expect((await svc.authorizeSpend(WS, "ads", 5_000)).allowed).toBe(false);

    const raise = await svc.requestRaise(WS, "ads", "member-1", 20_000);
    expect(raise.status).toBe("pending");
    // still blocked until a human approves
    expect((await svc.authorizeSpend(WS, "ads", 5_000)).allowed).toBe(false);

    const decided = await svc.approveRaise(WS, raise.id, "owner-9", "Q4 push");
    expect(decided.raise.status).toBe("approved");
    expect(decided.raise.decidedByMemberId).toBe("owner-9");
    expect(decided.status.capCents).toBe(20_000);

    // now the previously-blocked spend fits
    const ok = await svc.authorizeSpend(WS, "ads", 5_000);
    expect(ok.allowed).toBe(true);
  });

  it("rejects a non-increasing raise request and a reject leaves the cap unchanged", async () => {
    const { svc } = build();
    await svc.lowerCap(WS, "ads", 10_000);
    await expect(svc.requestRaise(WS, "ads", "m", 9_000)).rejects.toBeInstanceOf(SpendGovernorError);

    const raise = await svc.requestRaise(WS, "ads", "m", 15_000);
    const decided = await svc.rejectRaise(WS, raise.id, "owner-9", "not now");
    expect(decided.raise.status).toBe("rejected");
    expect(decided.status.capCents).toBe(10_000);
  });

  it("a cap-raise cannot be decided twice", async () => {
    const { svc } = build();
    await svc.lowerCap(WS, "ads", 10_000);
    const raise = await svc.requestRaise(WS, "ads", "m", 20_000);
    await svc.approveRaise(WS, raise.id, "owner");
    await expect(svc.approveRaise(WS, raise.id, "owner")).rejects.toBeInstanceOf(SpendGovernorError);
  });

  it("scopes cap-raises per workspace (#3 IDOR boundary)", async () => {
    const { svc } = build();
    await svc.lowerCap(WS, "ads", 10_000);
    const raise = await svc.requestRaise(WS, "ads", "m", 20_000);
    await expect(svc.approveRaise("ws-other", raise.id, "owner")).rejects.toBeInstanceOf(SpendGovernorError);
  });
});

describe("SpendGovernorService — settle/release + visibility", () => {
  it("settles a reservation into committed and exposes current spend across channels", async () => {
    const { svc } = build();
    await svc.lowerCap(WS, "ads", 10_000);
    await svc.authorizeSpend(WS, "ads", 4_000);
    await svc.settle(WS, "ads", 4_000, 3_200);
    const s = await svc.status(WS, "ads");
    expect(s.committedCents).toBe(3_200);
    expect(s.projectedCents).toBe(0);

    await svc.lowerCap(WS, "email", 5_000);
    const all = await svc.statuses(WS);
    expect(all.map((r) => r.channel)).toEqual(["ads", "email"]);
  });

  it("releases a cancelled reservation back to headroom", async () => {
    const { svc } = build();
    await svc.lowerCap(WS, "ads", 10_000);
    await svc.authorizeSpend(WS, "ads", 4_000);
    await svc.release(WS, "ads", 4_000);
    expect((await svc.status(WS, "ads")).availableCents).toBe(10_000);
  });
});
