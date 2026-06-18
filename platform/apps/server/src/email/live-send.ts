import { EMAIL_LIVE_SEND_ACTION } from "../approvals/policy.js";
import type { EmailDeliverabilityConfig } from "../config/schema.js";
import type { DeliverabilityConfirmation } from "./deliverability.js";
import type { SendBudgetDecision } from "./rate-cap.js";

/**
 * The Postmark live-send gate (issue #268, ADR-0268, premortem #200 §4 + §6). Sending a real email is the
 * most irreversible acquisition action, so it can never be autonomous: this pure decision is the single
 * structural seam that says whether a real send may execute. It composes every safeguard the pipeline
 * enforces — the flag (default OFF, owner-workspace-first), the in-code compliance gate (#189), the
 * production-grounded SPF/DKIM/DMARC confirmation (#200 §3), the warmup + rate send budget, and the
 * injection-quarantine of any externally-sourced content (#200 §6) — and then REQUIRES an owner approval id
 * on top. There is no input that makes `proceed` true without an `approvalRequestId`; that is the
 * pre-commitment the premortem demands for an irreversible action. Pure: no IO, unit-tested offline.
 */

/**
 * Is a real Postmark send even *eligible* for this workspace? Default OFF and owner-workspace-first: a real
 * send is enabled only when `liveSendEnabled` is true AND (the block is broadened with `ownerWorkspaceOnly:
 * false`, OR the workspace is the named `ownerWorkspaceId`). Enabling without naming an owner workspace
 * provisions it for nobody. Total + pure.
 */
export function isLiveSendEnabledForWorkspace(
  config: EmailDeliverabilityConfig,
  workspaceId: string,
): boolean {
  if (!config.liveSendEnabled) return false;
  const ownerOnly = config.ownerWorkspaceOnly ?? true;
  if (!ownerOnly) return true;
  return Boolean(config.ownerWorkspaceId) && config.ownerWorkspaceId === workspaceId;
}

export interface LiveSendRequest {
  workspaceId: string;
  config: EmailDeliverabilityConfig;
  /** Result of the #189 `checkEmailCompliance` (footer + suppression + deliverable-recipient gate). */
  complianceOk: boolean;
  /** The production-grounded SPF/DKIM/DMARC confirmation (#200 §3). */
  deliverability: DeliverabilityConfirmation;
  /** The combined warmup + rolling-window send budget. */
  sendBudget: SendBudgetDecision;
  /** Did all externally-sourced content pass through quarantine/sanitization before composing? (#200 §6) */
  contentQuarantined: boolean;
  /** The owner's approval id — present ONLY after the owner approved this exact send through the #13 queue. */
  approvalRequestId: string | null;
}

export interface LiveSendVerdict {
  action: typeof EMAIL_LIVE_SEND_ACTION;
  /** Always true — a real send is the structural #13 always-gate, never autonomous (#200 §4). */
  requiresApproval: boolean;
  /** Is the send eligible to be PROPOSED to the owner (every precondition met)? */
  eligible: boolean;
  /** May the live send actually execute NOW? Only when eligible AND an owner approval id is attached. */
  proceed: boolean;
  /** Why the send is not eligible (empty when eligible). */
  blockers: string[];
}

/**
 * Decide whether a Postmark live send may proceed. It is ALWAYS the owner's call (`requiresApproval: true`),
 * is eligible only when every safeguard passes, and proceeds only when eligible AND the owner has approved
 * (an `approvalRequestId` is attached). Total + pure — the structural invariant that there is no autonomous
 * live-send path.
 */
export function decidePostmarkLiveSend(req: LiveSendRequest): LiveSendVerdict {
  const blockers: string[] = [];

  if (!isLiveSendEnabledForWorkspace(req.config, req.workspaceId)) {
    blockers.push("live send not enabled for this workspace (flag OFF / not the owner workspace)");
  }
  if (!req.complianceOk) {
    blockers.push("email failed the CAN-SPAM/GDPR compliance check");
  }
  if (!req.deliverability.deliverable) {
    blockers.push("deliverability not confirmed — SPF/DKIM/DMARC must pass on a real delivered message (#200 §3)");
  }
  if (!req.sendBudget.allowed) {
    blockers.push(`no send-budget headroom (warmup / rate cap): ${req.sendBudget.reason}`);
  }
  if (!req.contentQuarantined) {
    blockers.push("externally-sourced content was not quarantined — possible prompt injection (#200 §6)");
  }

  const eligible = blockers.length === 0;
  return {
    action: EMAIL_LIVE_SEND_ACTION,
    requiresApproval: true,
    eligible,
    // The structural invariant: NEVER proceed without both eligibility AND an owner approval id.
    proceed: eligible && req.approvalRequestId !== null && req.approvalRequestId.length > 0,
    blockers,
  };
}
