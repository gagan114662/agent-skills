/**
 * Oz-loops service (#356, ADR-0356) — the thin IO orchestrator. It owns **no new authority**: the pure
 * decide functions ({@link decideTriage}, {@link decideSpecDraft}, {@link decideReview},
 * {@link decidePrCommentResponse}) produce every advisory proposal, and the ONLY way to act on one is
 * {@link OzLoopsService.requestPublish}, which parks a PENDING `oz_loops.publish_proposal` request in the
 * #13 owner-approval queue. The loop never posts a comment, applies a label, closes an issue, or merges a
 * PR. The gate is enforced here too: when the loops are disabled for a workspace, `run` returns
 * `enabled: false` and produces nothing (default OFF, owner-workspace-first).
 */
import type {
  OzProposal,
  PrCommentInput,
  ReviewInput,
  SpecInput,
  TriageInput,
} from "./contract.js";
import { isOzLoopsEnabledForWorkspace, type OzLoopsCaps } from "./caps.js";
import { decideTriage } from "./triage.js";
import { decideSpecDraft } from "./spec.js";
import { decideReview } from "./review.js";
import { decidePrCommentResponse } from "./pr-comment.js";

/** Identity a loop runs as: the workspace + the member a staged publish request is attributed to. */
export interface OzLoopsIdentity {
  workspaceId: string;
  requesterMemberId: string;
}

/** A request to run one loop. Discriminated by `kind`. */
export type OzLoopsRequest =
  | { kind: "triage"; input: TriageInput }
  | { kind: "spec"; input: SpecInput }
  | { kind: "review"; input: ReviewInput }
  | { kind: "pr_comment"; input: PrCommentInput };

/** What `run` returns: whether the loops were enabled, and the advisory proposal if so. */
export interface OzLoopsRunResult {
  workspaceId: string;
  enabled: boolean;
  /** The advisory proposal, or null when the loops are disabled for this workspace. */
  proposal: OzProposal | null;
}

export interface OzLoopsDeps {
  /** Resolve the per-workspace caps (the flag + owner-first + bounds). */
  caps(workspaceId: string): OzLoopsCaps;
  /**
   * Park a publish request as a PENDING #13 request; returns the request id. This is the ONLY outward path —
   * acting on a proposal (post comment / apply labels / open spec issue) happens only after the owner's yes.
   */
  stage(input: {
    workspaceId: string;
    requesterMemberId: string;
    proposal: OzProposal;
  }): Promise<{ id: string }>;
}

export class OzLoopsService {
  constructor(private readonly deps: OzLoopsDeps) {}

  /**
   * Run one loop for a workspace. Fail-closed: if the loops are disabled for the workspace, returns
   * `enabled:false` and `proposal:null` — nothing is computed or staged. The result is ADVISORY; it is not
   * an action and nothing is posted.
   */
  run(identity: OzLoopsIdentity, request: OzLoopsRequest): OzLoopsRunResult {
    const caps = this.deps.caps(identity.workspaceId);
    if (!isOzLoopsEnabledForWorkspace(caps, identity.workspaceId)) {
      return { workspaceId: identity.workspaceId, enabled: false, proposal: null };
    }
    const proposal = this.decide(caps, request);
    return { workspaceId: identity.workspaceId, enabled: true, proposal };
  }

  /** Pure dispatch over the four loops, threading caps-derived bounds into the review loop. */
  private decide(caps: OzLoopsCaps, request: OzLoopsRequest): OzProposal {
    switch (request.kind) {
      case "triage":
        return decideTriage(request.input);
      case "spec":
        return decideSpecDraft(request.input);
      case "review":
        return decideReview(request.input, {
          maxFindings: caps.maxFindings,
          maxDiffChars: caps.maxDiffChars,
        });
      case "pr_comment":
        return decidePrCommentResponse(request.input);
    }
  }

  /**
   * Act on a proposal — the ONLY outward path, and it goes through #13. Parks a PENDING
   * `oz_loops.publish_proposal` request the owner approves (or not). Fail-closed: refuses when the loops are
   * disabled for the workspace. Returns the staged request id. Nothing is posted to GitHub here.
   */
  async requestPublish(
    identity: OzLoopsIdentity,
    proposal: OzProposal,
  ): Promise<{ enabled: boolean; requestId: string | null }> {
    const caps = this.deps.caps(identity.workspaceId);
    if (!isOzLoopsEnabledForWorkspace(caps, identity.workspaceId)) {
      return { enabled: false, requestId: null };
    }
    const req = await this.deps.stage({
      workspaceId: identity.workspaceId,
      requesterMemberId: identity.requesterMemberId,
      proposal,
    });
    return { enabled: true, requestId: req.id };
  }
}
