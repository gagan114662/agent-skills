/**
 * The enterprise layer service (issue #340, ADR-0340) — the runtime seam that ties the pure cores together:
 * usage metering ({@link metering}), the never-exceed budget caps ({@link budget}), and the Passport IdP gate
 * ({@link passport}). It is the governance + cost-control layer that lets ipop sell the fleet, and it is the
 * gate that BACKS bid's hard ad-spend caps: a department asks {@link decideSpend} BEFORE committing real
 * money, and an over-cap spend is parked for the owner through the #13 queue — never crossed autonomously.
 *
 * Default-OFF by construction (premortem #200): when the enterprise layer is not enabled for a workspace,
 * `recordUsage` shapes a receipt but persists NOTHING live, `decideSpend` computes the verdict but does NOT
 * enforce/park it, and the Passport gate is `open`. All IO is injected, so the whole service is unit-testable
 * without a DB.
 */

import {
  buildUsageReceipt,
  aggregateByAgent,
  aggregateByCustomer,
  type UsageMeasurement,
  type UsageReceipt,
  type AgentUsage,
  type CustomerUsage,
} from "./metering.js";
import { decideSpendAgainstCaps, type BudgetCap, type BudgetDecision, type BudgetScope } from "./budget.js";
import { decidePassport, type IdpAssertion, type PassportDecision } from "./passport.js";
import {
  isEnterpriseEnabledForWorkspace,
  isPassportEnabledForWorkspace,
  type EnterpriseCaps,
} from "./caps.js";

/** Persistence for metered usage receipts. Injected so the service is DB-free in the unit job. */
export interface EnterpriseUsageStore {
  record(receipt: UsageReceipt): Promise<void>;
  listByWorkspace(workspaceId: string, limit: number): Promise<UsageReceipt[]>;
}

/** Read-back of a provisioned budget cap (with its committed counter) for a scope+subject. */
export interface EnterpriseBudgetStore {
  getCap(workspaceId: string, scope: BudgetScope, subjectId: string): Promise<BudgetCap | null>;
}

/** The #13 gate the service parks a budget-breach approval against. */
export interface BudgetApprovalGate {
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    agentId: string;
    requestCents: number;
    decision: BudgetDecision;
  }): Promise<{ id: string }>;
}

export interface EnterpriseServiceDeps {
  /** Resolve the workspace's enterprise policy (production: `loadConfig` → `resolveEnterpriseCaps`). */
  loadCaps: (workspaceId: string) => EnterpriseCaps;
  usage: EnterpriseUsageStore;
  budgets: EnterpriseBudgetStore;
  approvals: BudgetApprovalGate;
  now?: () => number;
}

/** The result of metering one usage event. `recorded` is false when the layer is off (shaped, not stored). */
export interface RecordUsageResult {
  recorded: boolean;
  receipt: UsageReceipt;
}

/** The outcome of a spend check against the budget caps. */
export type SpendOutcome =
  /** The enterprise layer is off for this workspace — the decision is informational, not enforced. */
  | { status: "disabled"; decision: BudgetDecision }
  /** Within all caps — proceed autonomously. */
  | { status: "allowed"; decision: BudgetDecision }
  /** Over a cap — BLOCKED and parked for the owner via #13. */
  | { status: "breach_gated"; decision: BudgetDecision; approvalRequestId: string };

export interface DecideSpendInput {
  workspaceId: string;
  agentId: string;
  requestCents: number;
  /** The member on whose behalf the breach approval is filed (the agent's member id). */
  requesterMemberId: string;
}

export interface PassportCheckInput {
  workspaceId: string;
  identityPresent: boolean;
  assertion: IdpAssertion | null;
}

export class EnterpriseService {
  private readonly now: () => number;

  constructor(private readonly deps: EnterpriseServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Meter one usage event. The receipt is always shaped (so a caller can see what WOULD be recorded), but it
   * is persisted live ONLY when the enterprise layer is enabled for the workspace (default-OFF path).
   */
  async recordUsage(measurement: UsageMeasurement): Promise<RecordUsageResult> {
    const receipt = buildUsageReceipt(measurement, this.now());
    const caps = this.deps.loadCaps(measurement.workspaceId);
    if (!isEnterpriseEnabledForWorkspace(caps, measurement.workspaceId)) {
      return { recorded: false, receipt };
    }
    await this.deps.usage.record(receipt);
    return { recorded: true, receipt };
  }

  /**
   * Resolve the applicable caps (the customer cap for the workspace AND the agent cap), falling back to the
   * configured default cap cents when none is explicitly provisioned. A scope with neither a provisioned cap
   * nor a configured default is simply unbounded (no cap enforced for it).
   */
  private async applicableCaps(
    caps: EnterpriseCaps,
    workspaceId: string,
    agentId: string,
  ): Promise<BudgetCap[]> {
    const out: BudgetCap[] = [];
    const customer = await this.deps.budgets.getCap(workspaceId, "customer", workspaceId);
    if (customer) out.push(customer);
    else if (caps.defaultCustomerCapCents !== null)
      out.push({ scope: "customer", subjectId: workspaceId, capCents: caps.defaultCustomerCapCents, committedCents: 0 });
    const agent = await this.deps.budgets.getCap(workspaceId, "agent", agentId);
    if (agent) out.push(agent);
    else if (caps.defaultAgentCapCents !== null)
      out.push({ scope: "agent", subjectId: agentId, capCents: caps.defaultAgentCapCents, committedCents: 0 });
    return out;
  }

  /**
   * Decide whether a department may commit `requestCents` of real spend. The pure {@link decideSpendAgainstCaps}
   * is the verdict; when the layer is enabled and the verdict is a breach, the service parks a PENDING
   * {@link ENTERPRISE_BUDGET_BREACH_ACTION} for the owner. The system never crosses a cap on its own.
   */
  async decideSpend(input: DecideSpendInput): Promise<SpendOutcome> {
    const caps = this.deps.loadCaps(input.workspaceId);
    const applicable = await this.applicableCaps(caps, input.workspaceId, input.agentId);
    const decision = decideSpendAgainstCaps(applicable, input.requestCents);

    if (!isEnterpriseEnabledForWorkspace(caps, input.workspaceId)) {
      return { status: "disabled", decision };
    }
    if (decision.allowed) {
      return { status: "allowed", decision };
    }
    const req = await this.deps.approvals.submit({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      agentId: input.agentId,
      requestCents: input.requestCents,
      decision,
    });
    return { status: "breach_gated", decision, approvalRequestId: req.id };
  }

  /** Recent metered usage rolled up per department agent (the per-agent surface). */
  async usageByAgent(workspaceId: string): Promise<AgentUsage[]> {
    const caps = this.deps.loadCaps(workspaceId);
    const rows = await this.deps.usage.listByWorkspace(workspaceId, caps.usageListLimit);
    return aggregateByAgent(rows);
  }

  /** A customer's (workspace's) metered usage rolled up (the per-customer surface). */
  async usageByCustomer(workspaceId: string): Promise<CustomerUsage> {
    const caps = this.deps.loadCaps(workspaceId);
    const rows = await this.deps.usage.listByWorkspace(workspaceId, caps.usageListLimit);
    return aggregateByCustomer(rows, workspaceId);
  }

  /** The Passport IdP/SSO gate decision for a caller (open pass-through unless enforced for the workspace). */
  async passportDecision(input: PassportCheckInput): Promise<PassportDecision> {
    const caps = this.deps.loadCaps(input.workspaceId);
    return decidePassport({
      enabled: isPassportEnabledForWorkspace(caps, input.workspaceId),
      identityPresent: input.identityPresent,
      assertion: input.assertion,
      allowedProviders: caps.allowedIdpProviders,
    });
  }
}
