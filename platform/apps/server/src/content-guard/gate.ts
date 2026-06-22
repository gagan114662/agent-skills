/**
 * The PURE gate that enforces issue #674's core safety property: an action DERIVED FROM externally-fetched
 * content can never execute autonomously — it always requires explicit human approval, and high-confidence
 * injection can additionally hard-block the proposal outright. This is the load-bearing defense. Detection
 * (`detect.ts`) and fencing (`neutralize.ts`) reduce the odds an injection is even attempted or believed; the
 * gate guarantees that even a SUCCESSFUL injection the model fell for cannot turn into a real-world action
 * without a human in the loop.
 *
 * Premortem (#200 §6) + the #561 additive-gate invariant encoded in the SHAPE:
 *  - **Additive only.** `gateAction` can only ever ADD an approval requirement; there is no input that makes
 *    it return `autoExecute` for external-derived content. It mirrors the risk classifier: a safety layer
 *    that strictly tightens, never loosens, the existing #13 approval gate.
 *  - **Fail-closed on uncertainty.** Unknown / missing provenance is treated as `external` (the dangerous
 *    case). A malformed action descriptor is treated as the most dangerous interpretation. The default
 *    outcome is "needs approval", never "auto".
 *  - **Numbers/labels only, no free text.** The decision reads the action's structural provenance + the
 *    detector's severity enum — never the untrusted prose itself — so a poisoned read cannot flip the gate.
 *
 * Pure + total: no IO, no clock. The service/caller persists nothing here; it routes `needsApproval` outcomes
 * into the real #13 approval queue and refuses `blocked` ones.
 */

import type { Severity } from "./detect.js";
import { normalizeProvenance, type Provenance } from "./trust.js";

/** What the gate decided should happen to a proposed action. */
export type GateOutcome =
  /** No external influence and nothing suspicious — the caller's normal policy applies (the gate adds nothing). */
  | "auto"
  /** Derived from external content — must go through the #13 human-approval queue before executing. */
  | "needs-approval"
  /** External content with high-confidence injection — refuse to even propose; a human must intervene explicitly. */
  | "blocked";

/** A description of an action the agent is about to take, for the gate to rule on. Structural fields only. */
export interface ProposedAction {
  /** A stable action type (e.g. `email.send`, `payment.charge`, `file.delete`). For audit/messaging only. */
  type: string;
  /** Was this action shaped, in whole or in part, by externally-fetched content? Defaults fail-closed to true. */
  derivedFromExternal?: boolean;
  /** The provenance of the content that shaped it, when known. Anything but `trusted` is treated as external. */
  provenance?: Provenance | string;
  /** The worst injection severity detected in that content, if a scan was run. Absent ⇒ treated as unknown. */
  injectionSeverity?: Severity;
}

/** The gate's verdict on a single proposed action. */
export interface GateDecision {
  outcome: GateOutcome;
  /** Convenience: `true` for both `needs-approval` and `blocked`. */
  requiresApproval: boolean;
  /** Convenience: `true` only for `blocked`. */
  blocked: boolean;
  /** Whether the action's provenance resolved to external (attacker-influenceable). */
  external: boolean;
  reason: string;
}

/** Strictness knob for the gate (resolved from env in `caps.ts`). */
export interface GatePolicy {
  /**
   * Hard-block (refuse to even propose) when external content carries an injection at or above this severity.
   * Below it, the action still requires approval but is allowed to be proposed. `"none"` disables hard-blocking
   * (everything external becomes `needs-approval`); the approval requirement itself is NOT tunable.
   */
  hardBlockAtSeverity: Exclude<Severity, "none"> | "off";
}

export const DEFAULT_GATE_POLICY: GatePolicy = { hardBlockAtSeverity: "high" };

const SEVERITY_RANK: Record<Severity, number> = { none: 0, low: 1, medium: 2, high: 3 };

/**
 * Decide whether `derivedFromExternal` should be treated as true. Fail-closed: only an explicit `false` paired
 * with a provably `trusted` provenance counts as "not external". A missing flag, a non-boolean, or any
 * non-`trusted` provenance ⇒ external (the dangerous interpretation).
 */
function resolveExternal(action: ProposedAction): boolean {
  const provenance = normalizeProvenance(action.provenance);
  if (action.derivedFromExternal === false && provenance === "trusted") return false;
  if (action.derivedFromExternal === true) return true;
  // Unknown flag: lean on provenance, fail-closed (external unless provably trusted).
  return provenance !== "trusted";
}

/**
 * Rule on a single proposed action. Pure + total.
 *  - Not external ⇒ `auto` (the gate adds nothing; the caller's own policy still applies downstream).
 *  - External + injection severity at/above the hard-block threshold ⇒ `blocked`.
 *  - External otherwise ⇒ `needs-approval` (route to the #13 human-approval queue).
 * There is no path from external content to `auto`.
 */
export function gateAction(action: ProposedAction, policy: GatePolicy = DEFAULT_GATE_POLICY): GateDecision {
  const safeAction: ProposedAction =
    action && typeof action === "object" ? action : { type: "unknown", derivedFromExternal: true };
  const external = resolveExternal(safeAction);

  if (!external) {
    return {
      outcome: "auto",
      requiresApproval: false,
      blocked: false,
      external: false,
      reason: "action not derived from external content — no extra gate added",
    };
  }

  const severity: Severity = isSeverity(safeAction.injectionSeverity) ? safeAction.injectionSeverity : "none";
  const threshold = policy.hardBlockAtSeverity;
  const hardBlock =
    threshold !== "off" && SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold] && SEVERITY_RANK[severity] > 0;

  if (hardBlock) {
    return {
      outcome: "blocked",
      requiresApproval: true,
      blocked: true,
      external: true,
      reason: `blocked: external content carries a ${severity}-severity injection signal — refusing to act without explicit human intervention`,
    };
  }

  return {
    outcome: "needs-approval",
    requiresApproval: true,
    blocked: false,
    external: true,
    reason:
      severity === "none"
        ? "action derived from external content — requires human approval before executing"
        : `action derived from external content (${severity}-severity injection signal) — requires human approval before executing`,
  };
}

function isSeverity(value: unknown): value is Severity {
  return value === "none" || value === "low" || value === "medium" || value === "high";
}
