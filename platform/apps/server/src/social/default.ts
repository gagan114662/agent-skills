/**
 * #269 — production wiring for Echo social posting. Composes the {@link SocialPublishService} over the real
 * repos (`db/repositories/social.ts`), the #13 approvals queue (the gate ALWAYS parks a PENDING request —
 * the hard constraint), the connect-once aggregator bridge (the dry-run default — NO live client is wired in
 * this slice, so the bridge posts nothing real), and the per-workspace `social` config (default-OFF,
 * owner-workspace-first). A real aggregator (e.g. Ayrshare) is a deliberate, owner-gated follow-up wired
 * behind {@link createSocialAggregator}.
 */

import { createRequest } from "../db/repositories/approvals.js";
import { dbSocialPostStore, dbSocialResultStore } from "../db/repositories/social.js";
import { loadConfig } from "../config/loader.js";
import { SOCIAL_PUBLISH_POST_ACTION } from "../approvals/policy.js";
import { createSocialAggregator } from "./aggregator.js";
import { resolveSocialFlags, type SocialFlags } from "./decide.js";
import { createSocialPublishDispatcher, type SocialPublishDispatcher } from "./dispatcher.js";
import { SocialPublishService, type SocialApprovalGate } from "./service.js";

/** Resolve the social-posting flags for a workspace from its config (default-OFF, owner-first). */
export function socialFlagsFor(workspaceId: string): SocialFlags {
  return resolveSocialFlags(loadConfig(workspaceId).social, workspaceId);
}

/**
 * The #13 gate: ALWAYS parks a PENDING `social.publish_post` request the owner must approve before a post
 * fans out (ADR-0269 — no autonomous publish path; a post is irreversible). Mirrors the hosted/realworld
 * park-PENDING pattern. The payload is structural (post id + network list + schedule) — never the body.
 */
const socialApprovalGate: SocialApprovalGate = {
  async submit(input) {
    const req = await createRequest({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionType: SOCIAL_PUBLISH_POST_ACTION,
      payload: input.payload,
      amount: null,
      summary: input.summary,
      status: "pending", // irreversible outward send — parks in the decision queue (ADR-0269)
      expiresAt: null,
      events: [{ type: "requested", detail: { source: "social", ...input.payload } }],
    });
    return { id: req.id };
  },
};

/**
 * Build the production social-posting service over the real repos + the #13 gate. The aggregator is the
 * dry-run default (no live client) — wiring a real aggregator client here is the owner-gated follow-up.
 */
export function buildSocialPublishService(): SocialPublishService {
  return new SocialPublishService({
    posts: dbSocialPostStore,
    results: dbSocialResultStore,
    aggregator: createSocialAggregator({ client: null }),
    approvals: socialApprovalGate,
    flags: socialFlagsFor,
  });
}

/** Build the production publish dispatcher (the post-approval ship path for the #13 executor). */
export function buildSocialPublishDispatcher(): SocialPublishDispatcher {
  return createSocialPublishDispatcher({
    service: buildSocialPublishService(),
    flags: socialFlagsFor,
  });
}
