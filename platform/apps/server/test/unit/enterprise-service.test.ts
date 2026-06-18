import { describe, it, expect } from "vitest";
import { EnterpriseService } from "../../src/enterprise/service.js";
import { resolveEnterpriseCaps, type EnterpriseCaps } from "../../src/enterprise/caps.js";
import type { BudgetCap } from "../../src/enterprise/budget.js";
import type { UsageReceipt } from "../../src/enterprise/metering.js";
import { ENTERPRISE_BUDGET_BREACH_ACTION } from "../../src/approvals/policy.js";

const NOW = 1_700_000_000_000;
const OWNER = "ws_owner";

function caps(over: Partial<EnterpriseCaps> = {}): EnterpriseCaps {
  return { ...resolveEnterpriseCaps({ enabled: true, ownerWorkspaceId: OWNER }), ...over };
}

/** Build a service over in-memory fakes; returns the service + handles to inspect side effects. */
function build(opts: {
  caps?: EnterpriseCaps;
  budgetCaps?: BudgetCap[];
} = {}) {
  const recorded: UsageReceipt[] = [];
  const submitted: Array<{ actionType: string; amount: number | null; agentId: string }> = [];
  const c = opts.caps ?? caps();
  const service = new EnterpriseService({
    loadCaps: () => c,
    usage: {
      record: async (r) => {
        recorded.push(r);
      },
      listByWorkspace: async (wid) => recorded.filter((r) => r.workspaceId === wid),
    },
    budgets: {
      getCap: async (_wid, scope, subjectId) =>
        (opts.budgetCaps ?? []).find((b) => b.scope === scope && b.subjectId === subjectId) ?? null,
    },
    approvals: {
      submit: async (input) => {
        submitted.push({ actionType: ENTERPRISE_BUDGET_BREACH_ACTION, amount: input.requestCents, agentId: input.agentId });
        return { id: "appr_1" };
      },
    },
    now: () => NOW,
  });
  return { service, recorded, submitted };
}

describe("EnterpriseService — usage recording (gated, external-grounded)", () => {
  it("persists a metered receipt for an enabled workspace", async () => {
    const { service, recorded } = build();
    const res = await service.recordUsage({
      workspaceId: OWNER,
      agentId: "bid",
      kind: "model",
      resource: "claude-opus-4-8",
      units: 1,
      costCents: 100,
      externalRef: "anthropic_req_1",
    });
    expect(res.recorded).toBe(true);
    expect(res.receipt.verified).toBe(true);
    expect(recorded).toHaveLength(1);
  });

  it("does NOT persist live when the enterprise layer is OFF for the workspace (default-off path)", async () => {
    const { service, recorded } = build({ caps: resolveEnterpriseCaps(undefined) });
    const res = await service.recordUsage({
      workspaceId: OWNER,
      agentId: "bid",
      kind: "model",
      resource: "x",
      units: 1,
      costCents: 100,
      externalRef: "r",
    });
    expect(res.recorded).toBe(false);
    expect(res.receipt).toBeTruthy(); // still shaped, just not stored live
    expect(recorded).toHaveLength(0);
  });
});

describe("EnterpriseService — spend decision backs bid's money caps via #13", () => {
  it("ALLOWS a spend within both caps and parks no approval", async () => {
    const { service, submitted } = build({
      budgetCaps: [
        { scope: "customer", subjectId: OWNER, capCents: 100_000, committedCents: 0 },
        { scope: "agent", subjectId: "bid", capCents: 50_000, committedCents: 0 },
      ],
    });
    const res = await service.decideSpend({ workspaceId: OWNER, agentId: "bid", requestCents: 10_000, requesterMemberId: "m1" });
    expect(res.status).toBe("allowed");
    expect(res.decision.allowed).toBe(true);
    expect(submitted).toHaveLength(0);
  });

  it("BLOCKS an over-cap spend and parks a PENDING enterprise.budget_breach for the owner", async () => {
    const { service, submitted } = build({
      budgetCaps: [{ scope: "agent", subjectId: "bid", capCents: 5_000, committedCents: 4_000 }],
    });
    const res = await service.decideSpend({ workspaceId: OWNER, agentId: "bid", requestCents: 3_000, requesterMemberId: "m1" });
    expect(res.status).toBe("breach_gated");
    expect(res.decision.allowed).toBe(false);
    expect(res.approvalRequestId).toBe("appr_1");
    expect(submitted).toEqual([{ actionType: ENTERPRISE_BUDGET_BREACH_ACTION, amount: 3_000, agentId: "bid" }]);
  });

  it("uses the configured default per-agent cap when none is explicitly provisioned", async () => {
    const c = caps({ defaultAgentCapCents: 1_000 });
    const { service } = build({ caps: c, budgetCaps: [] });
    const res = await service.decideSpend({ workspaceId: OWNER, agentId: "bid", requestCents: 5_000, requesterMemberId: "m1" });
    expect(res.status).toBe("breach_gated"); // 5_000 > the 1_000 default cap
  });

  it("when the enterprise layer is OFF, the decision is computed but NOT enforced/parked", async () => {
    const { service, submitted } = build({
      caps: resolveEnterpriseCaps(undefined),
      budgetCaps: [{ scope: "agent", subjectId: "bid", capCents: 0, committedCents: 0 }],
    });
    const res = await service.decideSpend({ workspaceId: OWNER, agentId: "bid", requestCents: 10_000, requesterMemberId: "m1" });
    expect(res.status).toBe("disabled");
    expect(submitted).toHaveLength(0);
  });
});

describe("EnterpriseService — read surfaces + passport", () => {
  it("rolls usage up per agent and per customer", async () => {
    const { service } = build();
    await service.recordUsage({ workspaceId: OWNER, agentId: "bid", kind: "model", resource: "m", units: 1, costCents: 100, externalRef: "r1" });
    await service.recordUsage({ workspaceId: OWNER, agentId: "lens", kind: "tool", resource: "t", units: 1, costCents: 50, externalRef: "r2" });
    const byAgent = await service.usageByAgent(OWNER);
    expect(byAgent.map((a) => a.agentId).sort()).toEqual(["bid", "lens"]);
    const customer = await service.usageByCustomer(OWNER);
    expect(customer.totalCostCents).toBe(150);
    expect(customer.verifiedCostCents).toBe(150);
  });

  it("passport is OPEN (pass-through) when not enforced for the workspace", async () => {
    const { service } = build({ caps: caps({ passportEnabled: false }) });
    const d = await service.passportDecision({ workspaceId: OWNER, identityPresent: true, assertion: null });
    expect(d.status).toBe("open");
    expect(d.allow).toBe(true);
  });

  it("passport ENFORCES SSO when enabled for the workspace", async () => {
    const { service } = build({ caps: caps({ passportEnabled: true, allowedIdpProviders: ["google"] }) });
    const denied = await service.passportDecision({ workspaceId: OWNER, identityPresent: true, assertion: null });
    expect(denied.allow).toBe(false);
    expect(denied.status).toBe("sso_required");
    const ok = await service.passportDecision({
      workspaceId: OWNER,
      identityPresent: true,
      assertion: { provider: "google", subject: "u", verified: true },
    });
    expect(ok.allow).toBe(true);
  });
});
