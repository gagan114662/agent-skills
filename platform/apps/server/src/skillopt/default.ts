/**
 * Production wiring for the SkillOpt-Sleep service (#283, ADR-0283). Binds the pure service to real seams:
 *
 *   - `caps` — the layered #58 config (`skillopt` block → `resolveSkillOptCaps`). Default OFF, owner-first.
 *   - `agents` — the fleet's runbook docs, derived from the #282 agent registry contract (one source of
 *     truth; the loop improves each agent's `<handle>/runbook` procedure).
 *   - `stage` — parks a PENDING `skillopt.adopt_skill_edit` #13 request (behavior-altering, owner-only;
 *     recorded-only on approval). There is no autonomous-adopt path.
 *   - `harvest` / `replay` — the production defaults are CONSERVATIVE no-ops (`[]`): harvesting real
 *     transcripts and replaying them against external receipts (real spawns, real receipts — premortem #200
 *     §3) is the deliberate next slice of this epic, so until it lands the loop stages NOTHING even when
 *     enabled. This is the safest honest default: no self-reported signal can ever move a skill doc.
 *   - `loadSkillDoc` — a stable placeholder sha (never reached in production because `replay` returns `[]`;
 *     exercised only by unit tests with injected candidates).
 */
import { createHash } from "node:crypto";
import { createRequest } from "../db/repositories/approvals.js";
import { listEvalRuns } from "../db/repositories/evals.js";
import { listRecentMarketingTasksByDepartment } from "../db/repositories/marketing-tasks.js";
import { getWorkspaceOwnerMemberId } from "../db/repositories/members.js";
import { alreadyProposed, recordSkillOptRun } from "../db/repositories/skillopt-runs.js";
import { loadConfig } from "../config/loader.js";
import type { SessionLogger } from "../runtime/manager.js";
import { SkillOptEngine } from "./engine.js";
import { SKILLOPT_ADOPT_EDIT_ACTION } from "../approvals/policy.js";
import { agentContracts, contractForHandle } from "../agent-registry/contract.js";
import { attributionActive, maxChainAgeMs, resolveAttributionCaps } from "../attribution/caps.js";
import { projectAttributedRevenue, type AttributionServiceDeps } from "../attribution/service.js";
import { revenueRewardByChannel, type RevenueReward } from "../attribution/reward.js";
import { dbAttributionExposureStore } from "../db/repositories/attribution.js";
import { dbRevenueReader } from "../finance/default.js";
import { reduceMarketingTasksToSamples } from "./harvest.js";
import { resolveSkillOptCaps } from "./caps.js";
import { SkillOptService, type SkillOptAgentTarget, type SkillOptDeps } from "./service.js";
import type { EvalRegressionReweight } from "./cycle.js";

/** The fleet agents the loop improves: each registry agent's runbook (its #155 procedure doc). */
export function skillOptAgentTargets(): SkillOptAgentTarget[] {
  return agentContracts().map((c) => ({ handle: c.handle, skillId: `${c.handle}/runbook` }));
}

/**
 * Build the LIVE #390 revenue learning signal for a workspace (ADR-0390) from the #386 attributed-revenue
 * projection. Reuses the same caps + attribution service wiring as the `/me/attribution` read route: it
 * projects credit over receipts that already exist (the #98 Stripe webhook), then maps the verified +
 * caused `attributed` events through `revenueRewardByChannel`.
 *
 * Gated default-OFF, owner-first via `attributionActive`: when attribution is not active for the workspace
 * this returns `null`, so the skillopt service passes NO reweight and ranks by frequency byte-for-byte as
 * today. When active but the projection yields zero attributed receipts, the reward is EMPTY (the "no
 * receipts ⇒ no learning" dependency) and the service still passes no reweight. Adds NO money path — read
 * + ranking only.
 */
async function liveRevenueRewardFor(workspaceId: string): Promise<RevenueReward | null> {
  const caps = resolveAttributionCaps(loadConfig(workspaceId).attribution);
  if (!attributionActive(caps, workspaceId)) return null;
  const deps: AttributionServiceDeps = {
    store: dbAttributionExposureStore,
    revenue: dbRevenueReader,
    maxChainAgeMs: maxChainAgeMs(caps),
    now: () => Date.now(),
  };
  const projection = await projectAttributedRevenue(deps, workspaceId);
  return revenueRewardByChannel(projection.attributed);
}

/**
 * Build the #889 negative learning signal from recent persisted evals. Eval runs are currently agent-scoped,
 * not cluster-scoped, so production fails closed when a recent run regressed: do not stage a SkillOpt edit
 * for that agent until the regression is investigated. Tests can inject cluster keys for finer downranking.
 */
async function liveEvalRegressionReweightFor(input: {
  workspaceId: string;
  agentHandle: string;
}): Promise<EvalRegressionReweight | null> {
  const recent = await listEvalRuns(input.workspaceId, input.agentHandle, 10);
  if (!recent.some((run) => run.regressed)) return null;
  return {
    blockReason: `recent eval regression for ${input.agentHandle}; awaiting regression repair before staging SkillOpt edits`,
  };
}

/** Build the production-wired SkillOpt service. */
export function createDefaultSkillOptService(): SkillOptService {
  const deps: SkillOptDeps = {
    caps: (workspaceId) => resolveSkillOptCaps(loadConfig(workspaceId).skillopt),
    agents: () => skillOptAgentTargets(),
    // Harvest (ADR-0283 Follow-up #1): read the agent's REAL, audited briefs from `marketing_tasks` (the
    // record of every welcome/@mention session it ran) and reduce them to sanitized DATA samples. Resolving
    // the department from the registry contract keeps the agent source of truth in one place (#282). A
    // non-fleet handle harvests nothing (fail-closed). Quality is NOT inferred here — `succeeded` is only a
    // mining weight; nothing stages until the replay seam supplies an externally-verified reading.
    harvest: async (workspaceId, agentHandle) => {
      const department = contractForHandle(agentHandle)?.department;
      if (!department) return [];
      const rows = await listRecentMarketingTasksByDepartment(workspaceId, department);
      return reduceMarketingTasksToSamples(rows, agentHandle, department);
    },
    // The replay-against-receipts engine is still the deliberate next slice (real spawns → external
    // receipts → `ValidationReading`). Until it lands the loop sources no candidates, so even with real
    // harvested data it stages NOTHING — the safest honest default (#200 §2/§3).
    replay: () => Promise.resolve([]),
    loadSkillDoc: (skillId) =>
      Promise.resolve({ sha: createHash("sha256").update(skillId).digest("hex").slice(0, 16), text: "" }),
    // #390 (ADR-0390): build the live revenue reward from the #386 projection so the cycle learns toward
    // what earns. Gated default-OFF, owner-first inside the helper; null/empty ⇒ frequency-only, unchanged.
    revenueRewardFor: (workspaceId) => liveRevenueRewardFor(workspaceId),
    // #889: read recent eval runs before staging proposals. If the only safe signal is agent-level
    // regression, fail closed rather than reinforcing the current runbook.
    evalRegressionReweightFor: (input) => liveEvalRegressionReweightFor(input),
    // #283 persistence: the idempotency guard — never re-stage an edit already proposed against this doc.
    alreadyStaged: (input) =>
      alreadyProposed(input.workspaceId, input.agentHandle, input.clusterKey, input.currentDocSha),
    // #283 persistence: durably record the run + every agent's before/after signal. Recorded-only — it
    // stages nothing and grants no authority (adoption stays human-gated in the #13 queue).
    recordRun: (input) => recordSkillOptRun(input),
    stage: async (input) => {
      const req = await createRequest({
        workspaceId: input.workspaceId,
        requesterMemberId: input.requesterMemberId,
        actionType: SKILLOPT_ADOPT_EDIT_ACTION,
        payload: {
          handle: input.proposal.agentHandle,
          skillId: input.proposal.skillId,
          currentDocSha: input.proposal.currentDocSha,
          appendText: input.proposal.appendText,
          rationale: input.proposal.rationale,
          clusterKey: input.proposal.clusterKey,
          metric: input.proposal.validation.metric,
        },
        amount: null,
        summary:
          `Adopt @${input.proposal.agentHandle} skill edit (${input.proposal.skillId}): ` +
          `${input.proposal.appendText.slice(0, 100)}`,
        status: "pending", // behavior-altering, owner-only — parks in the decision queue (ADR-0283).
        expiresAt: null,
        events: [
          {
            type: "requested",
            detail: {
              source: "skillopt",
              handle: input.proposal.agentHandle,
              skillId: input.proposal.skillId,
              clusterKey: input.proposal.clusterKey,
            },
          },
        ],
      });
      return { id: req.id };
    },
  };
  return new SkillOptService(deps);
}

/**
 * Build the production-wired SkillOpt scheduled engine (#283, ADR-0283) — the nightly/idle "sleep" trigger.
 * Owner-workspace-first like the cadence engine: the work-list is the resolved `ownerWorkspaceId` (empty —
 * so it ticks nobody — until a deployment names one), and the service re-checks the per-workspace gate on
 * every pass. Default-OFF: with no `skillopt` config the timer is never started (`intervalMs` resolves to 0
 * in `index.ts`) and even a started timer runs nobody, so a deployment that sets nothing is unchanged.
 */
export function createDefaultSkillOptEngine(logger: SessionLogger): SkillOptEngine {
  const service = createDefaultSkillOptService();
  return new SkillOptEngine({
    ownerWorkspaces: () => {
      const ownerWs = resolveSkillOptCaps(loadConfig().skillopt).ownerWorkspaceId;
      return ownerWs ? [ownerWs] : [];
    },
    ownerMemberId: (workspaceId) => getWorkspaceOwnerMemberId(workspaceId),
    run: (identity) => service.runWorkspace(identity),
    logger,
  });
}
