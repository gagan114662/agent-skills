/**
 * Production wiring for the enterprise layer (#340, ADR-0340). Builds an {@link EnterpriseService} from the
 * layered config (#58 → {@link resolveEnterpriseCaps}), the enterprise metering + budget-cap repos, and the
 * #13 approvals queue (a budget-cap breach ALWAYS parks a PENDING `enterprise.budget_breach` for the owner).
 *
 * Default-OFF by construction: with no `enterprise.enabled` in config, `recordUsage` persists nothing, every
 * `decideSpend` returns `disabled`, and the Passport gate is `open`. This slice moves NO money — the breach
 * executor is recorded-only; live billing is a separate, owner-gated step.
 */

import { createRequest } from "../db/repositories/approvals.js";
import { dbEnterpriseUsageStore, dbEnterpriseBudgetStore } from "../db/repositories/enterprise.js";
import { loadConfig } from "../config/loader.js";
import { ENTERPRISE_BUDGET_BREACH_ACTION } from "../approvals/policy.js";
import { resolveEnterpriseCaps, type EnterpriseCaps } from "./caps.js";
import { EnterpriseService, type BudgetApprovalGate } from "./service.js";

/** Resolve the enterprise policy for a workspace from its layered config (default-OFF, owner-first). */
export function enterpriseCapsFor(workspaceId: string): EnterpriseCaps {
  return resolveEnterpriseCaps(loadConfig(workspaceId).enterprise);
}

/**
 * The #13 gate: parks a PENDING `enterprise.budget_breach` request the owner must approve before any spend
 * crosses a pre-committed cap (ADR-0340 — the cap is never crossed autonomously). The payload is structural
 * (agent id, amount, the breaching scopes) — never agent free text — so it is injection-safe.
 */
const budgetApprovalGate: BudgetApprovalGate = {
  async submit(input) {
    const scopes = input.decision.breaches.map((b) => ({
      scope: b.scope,
      subjectId: b.subjectId,
      capCents: b.capCents,
      overByCents: b.overByCents,
    }));
    const req = await createRequest({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionType: ENTERPRISE_BUDGET_BREACH_ACTION,
      payload: { agentId: input.agentId, requestCents: input.requestCents, breaches: scopes },
      amount: input.requestCents,
      summary: `${input.agentId} requests ${input.requestCents}¢ over its budget cap — owner approval required`,
      status: "pending", // money over a pre-committed cap — parks in the decision queue (ADR-0340)
      expiresAt: null,
      events: [{ type: "requested", detail: { source: "enterprise", agentId: input.agentId } }],
    });
    return { id: req.id };
  },
};

/** Build the production enterprise service over the real repos + the #13 gate. */
export function createDefaultEnterpriseService(): EnterpriseService {
  return new EnterpriseService({
    loadCaps: enterpriseCapsFor,
    usage: dbEnterpriseUsageStore,
    budgets: dbEnterpriseBudgetStore,
    approvals: budgetApprovalGate,
  });
}

/** A fully-inert service for the no-config / unit fallback — meters nothing, enforces nothing. */
export function createInertEnterpriseService(): EnterpriseService {
  return new EnterpriseService({
    loadCaps: () => resolveEnterpriseCaps(undefined),
    usage: { record: async () => {}, listByWorkspace: async () => [] },
    budgets: { getCap: async () => null },
    approvals: { submit: async () => ({ id: "" }) },
  });
}
