/**
 * #266 — the publish dispatcher: the bridge between the #13 approval queue and {@link HostedPublishService}.
 * Mirrors the #295 {@link DeliveryDispatcher} exactly: the OWNER's approval is the ship trigger, routing is
 * structural (the page id off the approval payload — never the content), and it is FAIL-CLOSED:
 *
 *   - an empty `approvalRequestId` ⇒ `null` (no publish — the structural proof nothing ships without an
 *     explicit owner approval),
 *   - the feature OFF for the workspace ⇒ `null` (default-OFF, owner-workspace-first),
 *   - a missing/invalid page id ⇒ `null`.
 *
 * A genuine publish failure throws {@link ActionExecutionError} so the approval records as failed (parity
 * with the delivery dispatcher).
 */

import { ActionExecutionError } from "../approvals/executor.js";
import type { HostedSitesFlags } from "./decide.js";
import type { HostedPublishService } from "./service.js";

export interface HostedShipResult {
  pageId: string;
  url: string;
  live: boolean;
}

export interface HostedShipContext {
  workspaceId: string;
  approvalRequestId: string;
}

export interface HostedPublishDispatcher {
  ship(payload: Record<string, unknown>, ctx: HostedShipContext): Promise<HostedShipResult | null>;
}

export interface HostedPublishDispatcherDeps {
  service: HostedPublishService;
  flags: (workspaceId: string) => HostedSitesFlags;
}

export function createHostedPublishDispatcher(
  deps: HostedPublishDispatcherDeps,
): HostedPublishDispatcher {
  return {
    async ship(payload, ctx) {
      if (!ctx.approvalRequestId) return null; // fail-closed: never publish without an approval id
      if (!deps.flags(ctx.workspaceId).enabled) return null; // default-OFF, owner-workspace-first
      const pageId = typeof payload.pageId === "string" ? payload.pageId : "";
      if (!pageId) return null;

      const result = await deps.service.executePublish({
        workspaceId: ctx.workspaceId,
        pageId,
        approvalRequestId: ctx.approvalRequestId,
      });
      if (result.status === "failed") {
        throw new ActionExecutionError(`hosted publish failed: ${result.error}`);
      }
      return { pageId: result.pageId, url: result.url, live: true };
    },
  };
}
