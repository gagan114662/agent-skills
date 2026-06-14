import type { ApprovalStatus } from "../approvals/policy.js";
import { evaluatePolicy } from "../approvals/policy.js";
import { createRequest, getRequest, listPolicyRules } from "../db/repositories/approvals.js";
import {
  getServiceStatus,
  resolveServiceSecrets,
  setServiceCredentials,
} from "../db/repositories/external-credentials.js";
import { dbMonetizationStore } from "../db/repositories/monetization.js";
import { listWorkspaceIds } from "../db/repositories/workspaces.js";
import { createBillingProvider } from "../billing/factory.js";
import { loadConfig } from "../config/loader.js";
import { loadEnv } from "../env.js";
import { getMaintenanceState } from "../maintenance/flag.js";
import type { SessionLogger } from "../runtime/manager.js";
import { resolveMonetizationCaps } from "./caps.js";
import {
  MonetizationService,
  type MoneyDecisionGate,
  type VentureStripeResolver,
} from "./service.js";
import { MonetizationEngine } from "./engine.js";

/**
 * Production wiring for venture monetization (#188, ADR-0188). Mirrors the #194 finance + #187 factory
 * `default.ts`: the plan/experiment/revenue store, the per-venture Stripe vault (#192), the #13 money gate
 * (`approval_policies` + `approval_requests`), and the inbound-only #98 billing provider are all real.
 * Default-OFF: with no `monetization` config the service's `enabled` guard refuses every step, so nothing
 * here runs, drafts, or ingests until a deployment turns it on AND a venture connects its OWN Stripe key.
 */

/** Per-venture Stripe vault over the #192 write-only `external_credentials` store, keyed by venture. */
const ventureStripeVault: VentureStripeResolver = {
  isConnected: async (workspaceId, ventureIdeaId) =>
    (await getServiceStatus(workspaceId, serviceKey(ventureIdeaId)))?.connected ?? false,
  resolve: (workspaceId, ventureIdeaId) => resolveServiceSecrets(workspaceId, serviceKey(ventureIdeaId)),
  connect: async (input) => {
    await setServiceCredentials({
      workspaceId: input.workspaceId,
      serviceKey: serviceKey(input.ventureIdeaId),
      secrets: input.secrets,
      scopes: ["billing"],
      connectedByMemberId: input.connectedByMemberId ?? null,
    });
  },
};

/** The per-venture vault key: a separate Stripe account per venture, never ipop's shared key. */
function serviceKey(ventureIdeaId: string): string {
  return `stripe:${ventureIdeaId}`;
}

/** A #13 gate over the (non-route) monetization money actions: create PENDING, read status. */
const moneyGate: MoneyDecisionGate = {
  submit: async (input) => {
    const req = await createRequest({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionType: input.actionKind,
      payload: input.payload,
      amount: input.amountCents ?? null,
      summary: input.summary,
      // every monetization money action is sensitive-by-default — always a human gate.
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested", detail: { source: "monetization", ...input.payload } }],
    });
    return { id: req.id };
  },
  status: async (approvalRequestId): Promise<ApprovalStatus | undefined> =>
    (await getRequest(approvalRequestId))?.status,
};

// Surfaced for parity with the factory gate (and any future route that gates a monetization action).
export const monetizationRequiresApproval = async (
  workspaceId: string,
  actionKind: string,
): Promise<boolean> =>
  evaluatePolicy({ actionType: actionKind }, await listPolicyRules(workspaceId)).requiresApproval;

export function createDefaultMonetizationService(logger?: SessionLogger): MonetizationService {
  return new MonetizationService({
    store: dbMonetizationStore,
    vault: ventureStripeVault,
    gate: moneyGate,
    billing: createBillingProvider(loadEnv().billing),
    caps: (workspaceId) => resolveMonetizationCaps(loadConfig(workspaceId).monetization),
    logger,
  });
}

export function createDefaultMonetizationEngine(
  logger: SessionLogger,
  service: MonetizationService,
): MonetizationEngine {
  return new MonetizationEngine({
    service,
    listWorkspaceIds,
    caps: (workspaceId) => resolveMonetizationCaps(loadConfig(workspaceId).monetization),
    maintenancePaused: async () => (await getMaintenanceState()).enabled,
    logger,
  });
}
