import { describe, it, expect } from "vitest";
import { PLANS, getPlan, planCaps, isPlanKey, type Plan } from "../../src/billing/plans.js";

/**
 * The pure plan catalog (#125): the single source of truth the pricing page and the server both read.
 * No I/O — these assert the shape, the caps mapping, and the ordering the UI relies on.
 */
describe("billing plan catalog (#125 — pure)", () => {
  it("ships exactly Starter, Pro, Agency in ascending price order", () => {
    expect(PLANS.map((p) => p.key)).toEqual(["starter", "pro", "agency"]);
    const prices = PLANS.map((p) => p.priceCents);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(new Set(prices).size).toBe(3); // strictly increasing, no ties
  });

  it("every plan is a complete, monthly, USD card with positive caps", () => {
    for (const p of PLANS) {
      expect(p.name).toBeTruthy();
      expect(p.tagline).toBeTruthy();
      expect(p.interval).toBe("month");
      expect(p.currency).toBe("usd");
      expect(p.priceCents).toBeGreaterThan(0);
      expect(p.agentSeats).toBeGreaterThan(0);
      expect(p.monthlySessionBudgetCents).toBeGreaterThan(0);
      expect(p.fleetSize).toBeGreaterThan(0);
      expect(p.highlights.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("caps grow with price (seats, budget, fleet all monotonically increase)", () => {
    const seats = PLANS.map((p) => p.agentSeats);
    const budgets = PLANS.map((p) => p.monthlySessionBudgetCents);
    const fleets = PLANS.map((p) => p.fleetSize);
    for (const arr of [seats, budgets, fleets]) {
      for (let i = 1; i < arr.length; i++) expect(arr[i]).toBeGreaterThan(arr[i - 1]!);
    }
  });

  it("marks exactly one featured plan (Pro — the recommended tier)", () => {
    const featured = PLANS.filter((p) => p.featured);
    expect(featured).toHaveLength(1);
    expect(featured[0]!.key).toBe("pro");
  });

  it("getPlan resolves known keys and rejects unknown ones", () => {
    expect(getPlan("pro")?.name).toBe("Pro");
    expect(getPlan("starter")?.key).toBe("starter");
    expect(getPlan("enterprise")).toBeUndefined();
    expect(getPlan("")).toBeUndefined();
  });

  it("isPlanKey is a precise type guard", () => {
    expect(isPlanKey("agency")).toBe(true);
    expect(isPlanKey("nope")).toBe(false);
  });

  it("planCaps projects only the tenant-cap dimensions", () => {
    const pro = getPlan("pro") as Plan;
    expect(planCaps(pro)).toEqual({
      agentSeats: pro.agentSeats,
      monthlySessionBudgetCents: pro.monthlySessionBudgetCents,
      fleetSize: pro.fleetSize,
    });
  });
});
