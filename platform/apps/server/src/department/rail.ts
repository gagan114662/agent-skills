import type { ApprovalStatus } from "../approvals/policy.js";

/**
 * The members-rail footer (#371, ADR-0371) — a **pure** projection of the department's standing:
 * "{n} humans · {n} agents · {n} decisions captured", matching reload.chat's footer. No IO; the route
 * gathers the member counts + the captured-decision count and hands them here.
 *
 * "Decisions captured" is the count of #13 approval requests that reached a human DECISION — approved,
 * executed (approved + run), failed (approved but execution errored), or rejected. A still-`pending`
 * request is no decision yet; an `expired` request lapsed without one. This grounds the footer in the
 * real governance trail (#200 §2: a count derived from the gate, never a vanity number).
 */
export const DECISION_STATUSES: readonly ApprovalStatus[] = ["approved", "executed", "failed", "rejected"];

/** True iff an approval-request status counts as a captured human decision. Pure + total. */
export function isCapturedDecision(status: ApprovalStatus): boolean {
  return DECISION_STATUSES.includes(status);
}

export interface MembersRail {
  humanCount: number;
  agentCount: number;
  decisionsCaptured: number;
  /** The rendered footer line, e.g. "6 humans · 7 agents · 247 decisions captured". */
  summary: string;
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Build the members-rail footer. Counts are clamped to non-negative integers so a bad input can never
 * render a negative or fractional count. Pure + total.
 */
export function buildMembersRail(input: {
  humanCount: number;
  agentCount: number;
  decisionsCaptured: number;
}): MembersRail {
  const humanCount = Math.max(0, Math.trunc(input.humanCount) || 0);
  const agentCount = Math.max(0, Math.trunc(input.agentCount) || 0);
  const decisionsCaptured = Math.max(0, Math.trunc(input.decisionsCaptured) || 0);
  const summary = `${pluralize(humanCount, "human")} · ${pluralize(agentCount, "agent")} · ${decisionsCaptured} decisions captured`;
  return { humanCount, agentCount, decisionsCaptured, summary };
}
