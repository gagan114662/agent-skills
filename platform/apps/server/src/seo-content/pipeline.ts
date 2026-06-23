/**
 * The pure transition core for the SEO content pipeline (issue #598). No IO, no clock, no randomness — just the
 * rules of the staged spine: what the next stage is, which stages require an approval before they may run, and
 * how a gate verdict maps onto a forward move or a block. Keeping this here makes the spine independently
 * testable and keeps the service (which owns the providers, store, and approval/enabled checks) thin.
 */

import type { GateDecision, GateReason, PipelineStage, RunStage } from "./types.js";
import { PIPELINE_STAGES } from "./types.js";

/** The two side-effecting stages that may only run from an approved item (the #13 queue). */
const APPROVAL_STAGES: ReadonlySet<PipelineStage> = new Set(["publish", "index_ping"]);

/** Does this stage publish/ping an external service, and therefore require an approval id before it may run? */
export function requiresApproval(stage: PipelineStage): boolean {
  return APPROVAL_STAGES.has(stage);
}

/** The stage that follows `stage` in the spine, or `"done"` when `stage` is the last executable stage. */
export function nextStage(stage: PipelineStage): RunStage {
  const idx = PIPELINE_STAGES.indexOf(stage);
  // idx is always valid for a PipelineStage; the last stage advances to the terminal "done".
  const next = PIPELINE_STAGES[idx + 1];
  return next ?? "done";
}

/** Zero-based position of a stage in the spine (handy for progress/UX). */
export function stageIndex(stage: PipelineStage): number {
  return PIPELINE_STAGES.indexOf(stage);
}

/** The decision the pure core hands back to the service after a stage's gate has been evaluated. */
export type StageTransition =
  | { kind: "advance"; from: PipelineStage; to: RunStage }
  | { kind: "block"; stage: PipelineStage; reasons: GateReason[] };

/**
 * Map a gate verdict at `stage` onto a transition: a passing gate advances to the next stage (or `"done"`), a
 * failing gate blocks AT `stage`, carrying the reasons. Fail-closed by construction — `block` is the only
 * non-advancing outcome, and it is reached for any non-`allow` decision.
 */
export function transitionForGate(stage: PipelineStage, gate: GateDecision): StageTransition {
  if (gate.decision === "allow") {
    return { kind: "advance", from: stage, to: nextStage(stage) };
  }
  return { kind: "block", stage, reasons: gate.reasons };
}

/** A run at `"done"` is terminal — the normal flow never advances it again. */
export function isExecutableStage(stage: RunStage): stage is PipelineStage {
  return stage !== "done";
}
