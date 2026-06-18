/**
 * Production wiring for the Oz-loops service (#356, ADR-0356). Binds the pure service to real seams:
 *
 *   - `caps` — the layered #58 config (`ozLoops` block → `resolveOzLoopsCaps`). Default OFF, owner-first.
 *   - `stage` — parks a PENDING `oz_loops.publish_proposal` #13 request (recorded-only on approval). This is
 *     the ONLY outward path; acting on a triage/review/spec/comment proposal happens only after the owner's
 *     yes. There is no autonomous post/label/close/merge path.
 *
 * NO GitHub provider is wired here. Posting a comment / applying labels / opening a spec issue against a
 * real repo requires the `gh`/GitHub-App surface (the #51 seam) AND is an outward action — both stay an
 * owner-gated follow-up (ADR-0356 "optional owner step"). Until then, approving a staged request is
 * recorded-only: the executor writes no file and makes no network call.
 */
import { createRequest } from "../db/repositories/approvals.js";
import { loadConfig } from "../config/loader.js";
import { OZ_LOOPS_PUBLISH_PROPOSAL_ACTION } from "../approvals/policy.js";
import { resolveOzLoopsCaps } from "./caps.js";
import { OzLoopsService, type OzLoopsDeps } from "./service.js";

/** Build the production-wired Oz-loops service. */
export function createDefaultOzLoopsService(): OzLoopsService {
  const deps: OzLoopsDeps = {
    caps: (workspaceId) => resolveOzLoopsCaps(loadConfig(workspaceId).ozLoops),
    stage: async (input) => {
      const req = await createRequest({
        workspaceId: input.workspaceId,
        requesterMemberId: input.requesterMemberId,
        actionType: OZ_LOOPS_PUBLISH_PROPOSAL_ACTION,
        payload: {
          loop: input.proposal.kind,
          summary: input.proposal.summary,
          injectionFlagged: input.proposal.injectionFlagged,
        },
        amount: null,
        summary: `Publish ${input.proposal.kind} proposal: ${input.proposal.summary.slice(0, 120)}`,
        status: "pending", // outward, owner-only — parks in the decision queue (ADR-0356). Never auto-acts.
        expiresAt: null,
        events: [
          {
            type: "requested",
            detail: {
              source: "oz-loops",
              loop: input.proposal.kind,
              injectionFlagged: input.proposal.injectionFlagged,
            },
          },
        ],
      });
      return { id: req.id };
    },
  };
  return new OzLoopsService(deps);
}
