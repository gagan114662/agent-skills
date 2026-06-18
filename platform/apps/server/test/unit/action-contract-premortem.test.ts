import { describe, it, expect } from "vitest";
import {
  composePremortemPanel,
  type PremortemPanelInput,
} from "../../src/founder-briefings/aggregate.js";
import {
  summarizeContractGovernance,
  openContract,
  proposeAction,
  submitForApproval,
  recordApprovalDecision,
  applyApproved,
  confirmVerified,
  markVerifyFailed,
  type ActionContract,
  type Observation,
} from "../../src/action-contract/contract.js";

/**
 * #337 — the action contract feeds the #200 premortem panel (FM#3): of the risky actions APPLIED under the
 * contract, how many proved success with a production-grounded receipt. The integration is additive — a
 * report that supplies no contract counters renders exactly as before.
 */

function input(overrides: Partial<PremortemPanelInput> = {}): PremortemPanelInput {
  return {
    venturesWithEdge: 2,
    totalVentures: 2,
    externallyVerifiedMetrics: 4,
    totalMetrics: 4,
    irreversibleActionCount: 0,
    decisionsPresented: 1,
    attentionBudget: 3,
    approvalsDecided: 1,
    approvalsRubberStamped: 0,
    ownerOverrides: 0,
    ...overrides,
  };
}

describe("premortem panel — contract receipt coverage gauge (#337/#200 FM#3)", () => {
  it("is null (and adds no flag) when no contract action applied in the window", () => {
    const p = composePremortemPanel(input());
    expect(p.contractReceiptCoveragePct).toBeNull();
    expect(p.flags).toEqual([]);
  });

  it("is 100 when every applied action proved success with a receipt", () => {
    const p = composePremortemPanel(
      input({ contractGovernedApplies: 3, contractVerifiedWithReceipt: 3 }),
    );
    expect(p.contractReceiptCoveragePct).toBe(100);
    expect(p.flags.some((f) => f.includes("production receipt"))).toBe(false);
  });

  it("flags applied actions that were marked done without a production receipt (FM#3)", () => {
    const p = composePremortemPanel(
      input({ contractGovernedApplies: 4, contractVerifiedWithReceipt: 1 }),
    );
    expect(p.contractReceiptCoveragePct).toBe(25);
    expect(p.flags.some((f) => f.includes("lack a production receipt"))).toBe(true);
  });
});

describe("summarizeContractGovernance — counts applies vs verified-with-receipt (#337)", () => {
  const obs: Observation = {
    workspaceId: "owner-ws",
    capability: "content.publish",
    reversibility: "reversible",
    summary: "publish",
  };

  function driveTo(phase: "applied" | "verified" | "failed"): ActionContract {
    let c = openContract(
      proposeAction({ observation: obs, diff: "@@ @@", prRef: "agent/337", rollbackPlan: "undo" }),
    );
    c = (submitForApproval(c, { approvalRequestId: "req" }) as { contract: typeof c }).contract;
    c = (recordApprovalDecision(c, { approved: true }) as { contract: typeof c }).contract;
    c = (applyApproved(c, { enabled: true, applyIrreversible: true }) as { contract: typeof c }).contract;
    if (phase === "applied") return c;
    if (phase === "failed") {
      return (markVerifyFailed(c, "503") as { contract: typeof c }).contract;
    }
    return (
      confirmVerified(c, {
        source: "live_url",
        externalRef: "https://ipop.ai/x",
        observedAt: "2026-06-18T00:00:00.000Z",
        httpStatus: 200,
      }) as { contract: typeof c }
    ).contract;
  }

  it("counts only applied contracts as applies and only verified-with-receipt as success", () => {
    const summary = summarizeContractGovernance([
      driveTo("applied"),
      driveTo("verified"),
      driveTo("failed"),
    ]);
    expect(summary.applied).toBe(3); // all three reached applied at some point
    expect(summary.verifiedWithReceipt).toBe(1); // only one ended verified with a receipt
  });

  it("an un-applied (still-proposed) contract counts as neither", () => {
    const c = openContract(
      proposeAction({ observation: obs, diff: "@@ @@", prRef: "agent/337", rollbackPlan: null }),
    );
    expect(summarizeContractGovernance([c])).toEqual({ applied: 0, verifiedWithReceipt: 0 });
  });
});
