import { isExternalReceipt, type ExternalReceipt } from "../action-contract/receipt.js";

/**
 * Autonomous venture-loop proof gate (#403).
 *
 * #403 is a loop claim, not a feature checklist. A single venture launch, a vanity metric, or a manual
 * founder intervention cannot prove it. The close bar is: start a company, earn real provider-receipted
 * money, feed that revenue into learning, kill/scale the portfolio from revenue, and repeat autonomously
 * under a hard spend cap with an armed kill switch.
 */

export type AutonomousVentureLoopRequirement =
  | "start_company"
  | "earn_real_money"
  | "learn_from_revenue"
  | "portfolio_kill_scale"
  | "autonomous_loop"
  | "bounded_safety";

export interface VentureLoopStartProof {
  readonly ventureId: string;
  readonly factoryRunId: string;
  readonly deployReceipt: ExternalReceipt;
  readonly backgroundTickEnabled: boolean;
  readonly tickIntervalMs: number;
}

export interface VentureLoopEarnProof {
  readonly provider: "stripe" | "paypal" | "bank" | "marketplace" | "manual_claim";
  readonly providerEventId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly receipt: ExternalReceipt;
}

export interface VentureLoopLearnProof {
  readonly skillOptRunId: string;
  readonly revenueRewardApplied: boolean;
  readonly demotedNonEarners: boolean;
  readonly promotedEarners: boolean;
}

export interface VentureLoopPortfolioProof {
  readonly lifecycleRunId: string;
  readonly killDecisionCount: number;
  readonly scaleDecisionCount: number;
  readonly usedRevenueReceiptsOnly: boolean;
}

export interface VentureLoopAutonomyProof {
  readonly autonomousTickCount: number;
  readonly humanInterventionCount: number;
  readonly lastTickReceipt: ExternalReceipt;
}

export interface VentureLoopSafetyProof {
  readonly killSwitchArmed: boolean;
  readonly hardSpendCapCents: number;
  readonly spentCents: number;
  readonly capRaiseApprovalRequired: boolean;
  readonly auditReceipt: ExternalReceipt;
}

export interface AutonomousVentureLoopProof {
  readonly start: VentureLoopStartProof;
  readonly earn: VentureLoopEarnProof;
  readonly learn: VentureLoopLearnProof;
  readonly portfolio: VentureLoopPortfolioProof;
  readonly loop: VentureLoopAutonomyProof;
  readonly safety: VentureLoopSafetyProof;
}

export interface AutonomousVentureLoopProofGap {
  readonly requirement: AutonomousVentureLoopRequirement;
  readonly message: string;
}

export interface AutonomousVentureLoopProofResult {
  readonly proven: boolean;
  readonly gaps: readonly AutonomousVentureLoopProofGap[];
}

function push(
  gaps: AutonomousVentureLoopProofGap[],
  requirement: AutonomousVentureLoopRequirement,
  message: string,
): void {
  gaps.push({ requirement, message });
}

export function verifyAutonomousVentureLoopProof(
  proof: AutonomousVentureLoopProof,
): AutonomousVentureLoopProofResult {
  const gaps: AutonomousVentureLoopProofGap[] = [];

  if (
    proof.start.ventureId.trim() === "" ||
    proof.start.factoryRunId.trim() === "" ||
    !isExternalReceipt(proof.start.deployReceipt)
  ) {
    push(gaps, "start_company", "A started company requires venture/factory ids and a live deploy receipt.");
  }
  if (!proof.start.backgroundTickEnabled || proof.start.tickIntervalMs <= 0) {
    push(gaps, "start_company", "The venture background tick must be enabled with a positive interval.");
  }

  if (proof.earn.provider === "manual_claim" || proof.earn.providerEventId.trim() === "" || proof.earn.amountCents <= 0) {
    push(gaps, "earn_real_money", "Revenue must be a positive provider event, not a manual claim or vanity metric.");
  }
  if (!isExternalReceipt(proof.earn.receipt) || proof.earn.receipt.source !== "production_readback") {
    push(gaps, "earn_real_money", "Revenue must have a production readback receipt from the payment provider.");
  }

  if (
    proof.learn.skillOptRunId.trim() === "" ||
    !proof.learn.revenueRewardApplied ||
    !proof.learn.demotedNonEarners ||
    !proof.learn.promotedEarners
  ) {
    push(
      gaps,
      "learn_from_revenue",
      "SkillOpt must apply revenue reward, promote earners, and demote non-earners.",
    );
  }

  if (proof.portfolio.lifecycleRunId.trim() === "" || !proof.portfolio.usedRevenueReceiptsOnly) {
    push(gaps, "portfolio_kill_scale", "Portfolio lifecycle must use verified revenue receipts only.");
  }
  if (proof.portfolio.killDecisionCount < 1 || proof.portfolio.scaleDecisionCount < 1) {
    push(gaps, "portfolio_kill_scale", "Portfolio proof needs at least one kill and one scale decision.");
  }

  if (proof.loop.autonomousTickCount < 2 || proof.loop.humanInterventionCount !== 0) {
    push(gaps, "autonomous_loop", "The loop must repeat autonomously without human intervention.");
  }
  if (!isExternalReceipt(proof.loop.lastTickReceipt) || proof.loop.lastTickReceipt.source !== "production_readback") {
    push(gaps, "autonomous_loop", "The latest autonomous tick must have a production readback receipt.");
  }

  if (!proof.safety.killSwitchArmed || !proof.safety.capRaiseApprovalRequired) {
    push(gaps, "bounded_safety", "Safety proof requires an armed kill switch and human approval for cap raises.");
  }
  if (proof.safety.hardSpendCapCents <= 0 || proof.safety.spentCents > proof.safety.hardSpendCapCents) {
    push(gaps, "bounded_safety", "Autonomous spend must stay within a positive hard cap.");
  }
  if (!isExternalReceipt(proof.safety.auditReceipt) || proof.safety.auditReceipt.source !== "production_readback") {
    push(gaps, "bounded_safety", "Safety/audit state must have a production readback receipt.");
  }

  return { proven: gaps.length === 0, gaps };
}
