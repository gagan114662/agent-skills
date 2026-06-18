/**
 * #269 — the social publish dispatcher: the bridge between the #13 approval queue and the
 * {@link SocialPublishService}. Mirrors the #266 hosted / #295 delivery dispatcher exactly: the OWNER's
 * approval is the ship trigger, routing is structural (the post id off the approval payload — never the
 * content), and it is FAIL-CLOSED:
 *
 *   - an empty `approvalRequestId` ⇒ `null` (no publish — the structural proof nothing posts without an
 *     explicit owner approval),
 *   - the feature OFF for the workspace ⇒ `null` (default-OFF, owner-workspace-first),
 *   - a missing/invalid post id ⇒ `null`.
 *
 * A genuine publish failure throws {@link ActionExecutionError} so the approval records as failed (parity
 * with the hosted/delivery dispatchers).
 */

import { ActionExecutionError } from "../approvals/executor.js";
import type { SocialNetworkReceipt } from "./aggregator.js";
import type { SocialFlags } from "./decide.js";
import type { SocialPublishService } from "./service.js";

export interface SocialShipResult {
  postId: string;
  status: "published" | "partially_published" | "scheduled";
  /** True only when a LIVE aggregator actually posted (false for the dry-run default). */
  live: boolean;
  receipts: SocialNetworkReceipt[];
}

export interface SocialShipContext {
  workspaceId: string;
  approvalRequestId: string;
}

export interface SocialPublishDispatcher {
  ship(payload: Record<string, unknown>, ctx: SocialShipContext): Promise<SocialShipResult | null>;
}

export interface SocialPublishDispatcherDeps {
  service: SocialPublishService;
  flags: (workspaceId: string) => SocialFlags;
}

export function createSocialPublishDispatcher(
  deps: SocialPublishDispatcherDeps,
): SocialPublishDispatcher {
  return {
    async ship(payload, ctx) {
      if (!ctx.approvalRequestId) return null; // fail-closed: never post without an approval id
      if (!deps.flags(ctx.workspaceId).enabled) return null; // default-OFF, owner-workspace-first
      const postId = typeof payload.postId === "string" ? payload.postId : "";
      if (!postId) return null;

      const result = await deps.service.executePublish({
        workspaceId: ctx.workspaceId,
        postId,
        approvalRequestId: ctx.approvalRequestId,
      });
      if (result.status === "failed") {
        throw new ActionExecutionError(`social publish failed: ${result.error}`);
      }
      return { postId: result.postId, status: result.status, live: result.live, receipts: result.receipts };
    },
  };
}
