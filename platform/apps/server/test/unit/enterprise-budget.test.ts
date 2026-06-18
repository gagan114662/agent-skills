import { describe, it, expect } from "vitest";
import {
  decideSpendAgainstCaps,
  capStatus,
  applyCommit,
  type BudgetCap,
} from "../../src/enterprise/budget.js";
import { ENTERPRISE_BUDGET_BREACH_ACTION } from "../../src/approvals/policy.js";

function cap(over: Partial<BudgetCap> = {}): BudgetCap {
  return { scope: "customer", subjectId: "ws_1", capCents: 10_000, committedCents: 0, ...over };
}

describe("enterprise budget caps — hard never-exceed decision (#340)", () => {
  it("allows a spend that fits within every applicable cap", () => {
    const d = decideSpendAgainstCaps([cap({ committedCents: 4_000 })], 5_000);
    expect(d.allowed).toBe(true);
    expect(d.requiresOwner).toBe(false);
    expect(d.breaches).toHaveLength(0);
  });

  it("a request exactly equal to the remaining headroom is allowed (boundary)", () => {
    const d = decideSpendAgainstCaps([cap({ capCents: 10_000, committedCents: 6_000 })], 4_000);
    expect(d.allowed).toBe(true);
  });

  it("BLOCKS a spend that would exceed the cap and routes it to the owner via #13", () => {
    const d = decideSpendAgainstCaps([cap({ capCents: 10_000, committedCents: 8_000 })], 5_000);
    expect(d.allowed).toBe(false);
    expect(d.requiresOwner).toBe(true);
    expect(d.actionType).toBe(ENTERPRISE_BUDGET_BREACH_ACTION);
    expect(d.breaches).toHaveLength(1);
    expect(d.breaches[0]).toMatchObject({ scope: "customer", overByCents: 3_000 });
  });

  it("enforces the TIGHTEST of a per-agent AND a per-customer cap together", () => {
    const customer = cap({ scope: "customer", subjectId: "ws_1", capCents: 100_000, committedCents: 0 });
    const agent = cap({ scope: "agent", subjectId: "bid", capCents: 5_000, committedCents: 4_000 });
    const d = decideSpendAgainstCaps([customer, agent], 2_000);
    expect(d.allowed).toBe(false); // fits the customer cap but breaches the agent cap
    expect(d.breaches.map((b) => b.scope)).toEqual(["agent"]);
  });

  it("reports EVERY breaching scope when both caps are exceeded", () => {
    const customer = cap({ scope: "customer", subjectId: "ws_1", capCents: 1_000, committedCents: 900 });
    const agent = cap({ scope: "agent", subjectId: "bid", capCents: 500, committedCents: 400 });
    const d = decideSpendAgainstCaps([customer, agent], 5_000);
    expect(d.breaches.map((b) => b.scope).sort()).toEqual(["agent", "customer"]);
  });

  it("a non-positive request is a no-op (allowed, spends nothing, no owner needed)", () => {
    expect(decideSpendAgainstCaps([cap()], 0).allowed).toBe(true);
    expect(decideSpendAgainstCaps([cap()], -100).requiresOwner).toBe(false);
  });

  it("with no caps configured nothing is enforced (allowed) — caps are opt-in", () => {
    expect(decideSpendAgainstCaps([], 999_999).allowed).toBe(true);
  });
});

describe("enterprise budget caps — the system NEVER crosses a cap (property)", () => {
  it("repeatedly applying only ALLOWED spends never pushes committed over the cap", () => {
    let c = cap({ capCents: 10_000, committedCents: 0 });
    const requests = [3_000, 4_000, 5_000, 1_000, 2_500, 100, 9_999];
    for (const req of requests) {
      const d = decideSpendAgainstCaps([c], req);
      if (d.allowed) c = { ...c, committedCents: applyCommit(c, req) };
      expect(c.committedCents).toBeLessThanOrEqual(c.capCents);
    }
    // After the sequence we are at or under the cap, never above.
    expect(c.committedCents).toBeLessThanOrEqual(10_000);
  });

  it("once the cap is reached, any further positive spend is blocked (no autonomous over-spend)", () => {
    const full = cap({ capCents: 10_000, committedCents: 10_000 });
    expect(decideSpendAgainstCaps([full], 1).allowed).toBe(false);
    expect(capStatus(full).exhausted).toBe(true);
    expect(capStatus(full).remainingCents).toBe(0);
  });
});

describe("enterprise budget caps — injection / poisoned-number defense (#200 §6)", () => {
  it("an indeterminate (NaN/Infinity) request never auto-spends — it requires the owner", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = decideSpendAgainstCaps([cap({ committedCents: 0 })], bad);
      expect(d.allowed).toBe(false);
      expect(d.requiresOwner).toBe(true);
    }
  });

  it("a poisoned negative committed counter is clamped to 0 (cannot manufacture extra headroom beyond cap)", () => {
    const poisoned = cap({ capCents: 10_000, committedCents: -1_000_000 });
    // remaining is capped at capCents, not cap - (negative) = more than cap.
    expect(capStatus(poisoned).remainingCents).toBe(10_000);
    expect(decideSpendAgainstCaps([poisoned], 10_001).allowed).toBe(false);
  });

  it("a poisoned non-finite cap blocks everything (fail-closed, never an open spend)", () => {
    const poisoned = cap({ capCents: Number.POSITIVE_INFINITY, committedCents: 0 });
    expect(decideSpendAgainstCaps([poisoned], 1).allowed).toBe(false);
  });
});
