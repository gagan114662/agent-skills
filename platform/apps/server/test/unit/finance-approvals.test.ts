import { describe, it, expect } from "vitest";
import { buildDefaultRegistry } from "../../src/approvals/runtime.js";
import {
  evaluatePolicy,
  DEFAULT_SENSITIVE_ACTIONS,
  FINANCE_DISBURSEMENT_ACTION,
} from "../../src/approvals/policy.js";
import { validateFinanceDisbursement } from "../../src/approvals/executor.js";
import { composeWeeklyReport, type FinanceBriefingSection } from "../../src/founder-briefings/aggregate.js";

describe("finance.disbursement is human-gated + recorded-only (#194)", () => {
  it("is sensitive by default — gated when no workspace rule matches", () => {
    expect(DEFAULT_SENSITIVE_ACTIONS).toContain(FINANCE_DISBURSEMENT_ACTION);
    const d = evaluatePolicy({ actionType: FINANCE_DISBURSEMENT_ACTION, amount: 5000 }, []);
    expect(d.requiresApproval).toBe(true);
  });

  it("validates the recorded intent shape", () => {
    expect(validateFinanceDisbursement({ amountCents: 5000, purpose: "ad budget" }).ok).toBe(true);
    expect(validateFinanceDisbursement({ amountCents: 0, purpose: "x" }).ok).toBe(false);
    expect(validateFinanceDisbursement({ amountCents: 5000 }).ok).toBe(false); // no purpose
  });

  it("the executor records the intent but MOVES NO MONEY", async () => {
    const reg = buildDefaultRegistry();
    const exec = reg.get(FINANCE_DISBURSEMENT_ACTION)!;
    expect(exec).toBeDefined();
    const result = await exec.execute(
      { amountCents: 5000, currency: "usd", purpose: "ad budget" },
      { workspaceId: "ws1", requesterMemberId: "m1" } as never,
    );
    expect(result).toMatchObject({ recorded: true, executed: false, amountCents: 5000 });
  });
});

describe("weekly report finance section (#194 attach)", () => {
  const base = {
    workspaceId: "ws1",
    nowMs: Date.parse("2026-02-20T00:00:00Z"),
    brandName: "ipop",
    currency: "usd",
    revenueTotalCents: 15000,
    ventures: [],
    voiceSignals: [],
    backlog: [],
    maxWords: 400,
  };

  it("renders the close-pack line when the section is present", () => {
    const financeSection: FinanceBriefingSection = {
      currency: "usd",
      periodKey: "2026-02",
      revenueCents: 15000,
      costCents: 4000,
      netCents: 11000,
      verifiedShareBps: 7895,
      runwayHealth: "at_risk",
      runwayDays: 45,
      breachPeriodKey: "2026-05",
    };
    const out = composeWeeklyReport({ ...base, financeSection });
    expect(out.financeSection).toEqual(financeSection);
    expect(out.text).toContain("Books 2026-02");
    expect(out.text).toContain("79% verified");
    expect(out.text).toContain("at risk");
  });

  it("omits the line and is unchanged when the section is absent", () => {
    const out = composeWeeklyReport(base);
    expect(out.financeSection).toBeNull();
    expect(out.text).not.toContain("Books");
  });
});
