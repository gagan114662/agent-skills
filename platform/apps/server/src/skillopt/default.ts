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
import { loadConfig } from "../config/loader.js";
import { SKILLOPT_ADOPT_EDIT_ACTION } from "../approvals/policy.js";
import { agentContracts } from "../agent-registry/contract.js";
import { resolveSkillOptCaps } from "./caps.js";
import { SkillOptService, type SkillOptAgentTarget, type SkillOptDeps } from "./service.js";

/** The fleet agents the loop improves: each registry agent's runbook (its #155 procedure doc). */
export function skillOptAgentTargets(): SkillOptAgentTarget[] {
  return agentContracts().map((c) => ({ handle: c.handle, skillId: `${c.handle}/runbook` }));
}

/** Build the production-wired SkillOpt service. */
export function createDefaultSkillOptService(): SkillOptService {
  const deps: SkillOptDeps = {
    caps: (workspaceId) => resolveSkillOptCaps(loadConfig(workspaceId).skillopt),
    agents: () => skillOptAgentTargets(),
    // The real transcript-harvest + replay-against-receipts engine is the deliberate next slice (#283
    // follow-up). Until then the loop sources no candidates, so it never stages a self-reported edit.
    harvest: () => Promise.resolve([]),
    replay: () => Promise.resolve([]),
    loadSkillDoc: (skillId) =>
      Promise.resolve({ sha: createHash("sha256").update(skillId).digest("hex").slice(0, 16), text: "" }),
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
