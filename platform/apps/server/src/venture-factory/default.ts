import { loadConfig } from "../config/loader.js";
import { windowKey } from "../scale/usage.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { resolveVentureFactoryCaps } from "./caps.js";
import {
  VentureFactoryService,
  type FactoryStore,
  type FleetSeeder,
  type ProfitabilityReader,
  type SmokeTestPublisher,
  type VentureArchiver,
  type VentureFactoryDeps,
} from "./service.js";
import { VentureFactoryEngine } from "./engine.js";
import {
  insertCandidate,
  getCandidate,
  listCandidatesByStatus,
  setCandidate,
  ensureValidation,
  getValidationByCandidate,
  updateValidation,
  ensureVenture,
  getVentureByCandidate,
  setVenture,
  countActiveVentures,
  listScannedCandidateWorkspaces,
} from "../db/repositories/venture-factory.js";
import { listWorkspaceMembers } from "../db/repositories/members.js";
import {
  createRequest,
  getRequest,
  listPolicyRules,
} from "../db/repositories/approvals.js";
import { getControls } from "../db/repositories/autonomy.js";
import { getUsage, recordSessionCompute } from "../db/repositories/tenant-usage.js";
import { evaluatePolicy } from "../approvals/policy.js";
import type { ApprovalStatus } from "../approvals/policy.js";
import type { SessionLogger } from "../runtime/manager.js";

/**
 * Production wiring for the Venture Factory (#187, ADR-0187). The candidate/validation/venture stores,
 * the #13 gate (`approval_policies` + `approval_requests`), the #17 kill switch, and the #71 dollar
 * ceiling are real. The collaborators that reach OTHER subsystems — the #138 fleet seed, the external
 * profitability reader (#98), and the venture archiver (#107) — are INJECTED by `app.ts`, which already
 * owns those services; here they default to safe no-ops (a missing profitability reader returns 0, so
 * the FM#1 scaling gate conservatively waits for a real profit signal). Default-OFF: with no
 * `ventureFactory` config the service's `enabled` guard refuses every autonomous step.
 */

/** The persistence seam, bound to the real repositories. */
const factoryStore: FactoryStore = {
  insertCandidate,
  getCandidate,
  listCandidatesByStatus,
  setCandidate,
  ensureValidation,
  getValidationByCandidate,
  updateValidation,
  ensureVenture,
  getVentureByCandidate,
  setVenture,
  countActiveVentures,
};

/** A #13 gate over a (non-route) action kind: read the workspace policy, create PENDING when gated. */
const approvalGate: VentureFactoryDeps["gate"] = {
  requiresApproval: async (workspaceId, actionKind) =>
    evaluatePolicy({ actionType: actionKind }, await listPolicyRules(workspaceId)).requiresApproval,
  submit: async (input) => {
    const req = await createRequest({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionType: input.actionKind,
      payload: input.payload,
      amount: input.amountCents ?? null,
      summary: input.summary,
      // every factory action kind is sensitive-by-default (MONEY/launch) — always a human gate.
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested", detail: { source: "venture-factory", ...input.payload } }],
    });
    return { id: req.id };
  },
  status: async (approvalRequestId): Promise<ApprovalStatus | undefined> =>
    (await getRequest(approvalRequestId))?.status,
};

/** The #17 kill switch — the same control that bounds autonomy launches. */
const killSwitch: VentureFactoryDeps["killSwitch"] = {
  isTripped: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
};

/**
 * The #71 dollar ceiling, reusing the SAME tenant-usage accounting as sessions/ventures: a scan pass
 * charges `cents`, and the charge is REFUSED (returns false) when it would cross the scale budget — so a
 * runaway scanner cannot outspend the tenant's cap.
 */
const budget: VentureFactoryDeps["budget"] = {
  charge: async (workspaceId, cents, _reason) => {
    if (cents <= 0) return true;
    const now = new Date();
    const budgetCents = resolveScaleCaps(loadConfig(workspaceId).scale).budgetCents;
    const spent = (await getUsage(workspaceId, windowKey(now))).estimatedCostCents;
    if (budgetCents > 0 && spent + cents > budgetCents) return false;
    await recordSessionCompute(workspaceId, windowKey(now), 0, cents);
    return true;
  },
};

/** The smoke-test publisher: ship the landing + waitlist as a gated external.send (#153 patterns, #13). */
function smokeTestPublisher(): SmokeTestPublisher {
  return {
    publish: async (input) => {
      const req = await createRequest({
        workspaceId: input.workspaceId,
        requesterMemberId: input.requesterMemberId,
        actionType: "external.send", // sensitive-by-default → the landing publish pauses for a human
        payload: {
          kind: "content.publish",
          summary: `Smoke-test landing + waitlist for ${input.ventureName}`,
          candidateId: input.candidateId,
        },
        amount: null,
        summary: `Publish smoke-test landing for ${input.ventureName}`,
        status: "pending",
        expiresAt: null,
        events: [{ type: "requested", detail: { source: "venture-factory", candidateId: input.candidateId } }],
      });
      return { approvalRequestId: req.id };
    },
  };
}

/** Default fleet seeder: a no-op until `app.ts` injects the real #138 marketing seed. */
const noopFleetSeeder: FleetSeeder = { seed: async () => {} };

/** Default profitability reader: 0 (conservative — the FM#1 scaling gate waits for a real profit signal). */
const noopProfitabilityReader: ProfitabilityReader = { externallyProfitableCount: async () => 0 };

/** Default archiver: a no-op until `app.ts` injects the real #107 teardown. */
const noopArchiver: VentureArchiver = { archive: async () => {} };

export interface DefaultVentureFactoryDeps {
  /** The real #138 fleet seed (app.ts passes the marketing seeder). */
  fleet?: FleetSeeder;
  /** The real #98 external-profitability reader (app.ts passes a billing-backed reader). */
  profitability?: ProfitabilityReader;
  /** The real #107 venture archiver. */
  archiver?: VentureArchiver;
  /** The owner workspace resolver for `ownerWorkspaceOnly`. */
  ownerWorkspaceId?: (workspaceId: string) => Promise<string | null>;
  now?: () => Date;
}

export function createDefaultVentureFactoryService(
  deps: DefaultVentureFactoryDeps = {},
): VentureFactoryService {
  const wiring: VentureFactoryDeps = {
    store: factoryStore,
    gate: approvalGate,
    killSwitch,
    budget,
    fleet: deps.fleet ?? noopFleetSeeder,
    smokeTest: smokeTestPublisher(),
    profitability: deps.profitability ?? noopProfitabilityReader,
    archiver: deps.archiver ?? noopArchiver,
    ownerWorkspaceId: deps.ownerWorkspaceId,
    caps: (workspaceId) => resolveVentureFactoryCaps(loadConfig(workspaceId).ventureFactory),
    now: deps.now,
  };
  return new VentureFactoryService(wiring);
}

/**
 * Build the production VentureFactoryEngine (#187 scanner tick). The timer is started in `index.ts` only
 * when `VENTURE_FACTORY_INTERVAL_MS > 0`. The work-list is every workspace with a `scanned` candidate;
 * `requesterMemberId` must resolve to an AGENT member (the #13 FK) — `app.ts` supplies it.
 */
export function createDefaultVentureFactoryEngine(
  logger: SessionLogger,
  deps: DefaultVentureFactoryDeps & {
    listFactoryWorkspaces?: () => Promise<string[]>;
    requesterMemberId?: (workspaceId: string) => Promise<string | null>;
  } = {},
): VentureFactoryEngine {
  return new VentureFactoryEngine({
    factory: createDefaultVentureFactoryService(deps),
    // Default work-list: every workspace with a `scanned` candidate.
    listFactoryWorkspaces: deps.listFactoryWorkspaces ?? listScannedCandidateWorkspaces,
    // Default requester: the workspace's first AGENT member (the #13 FK; an agent never approves its own
    // gate, so the human owner stays the approver). A workspace with no agent member is skipped by the engine.
    requesterMemberId:
      deps.requesterMemberId ??
      (async (workspaceId) =>
        (await listWorkspaceMembers(workspaceId)).find((m) => m.kind === "agent")?.id ?? null),
    logger,
  });
}
