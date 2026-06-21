/**
 * First-run setup checklist (#479) — PURE so every branch is unit-tested without a network. A fresh
 * workspace lands with an unset brand kit, no connected accounts, and quiet channels — no guided path from
 * signup to first real output. This derives the four-step path the user follows:
 *
 *   1. set your brand   →  2. connect one account   →  3. run an agent   →  4. see & approve the result
 *
 * Each step's `done` is derived from REAL signals (the brand kit, the connections list, agent activity, an
 * executed approval), never a guess — so the checklist reflects what the user has actually accomplished and
 * disappears for good once every step is real. Display copy lives in brand.ts; this module is logic only.
 */

export type FirstRunStepKey = "brand" | "connect" | "run" | "approve";

/** The real, observed setup state of the workspace. All booleans — the caller resolves them from live data. */
export interface FirstRunSignals {
  /** A brand kit has been saved (BrandKitState.connected). */
  brandSet: boolean;
  /** At least one external account is connected (any ConnectionView.connected). */
  hasConnection: boolean;
  /** An agent has actually run — an agent-authored message exists, a session is live, or a result/approval
   *  has appeared (any of which is downstream of a real run). */
  agentRan: boolean;
  /** At least one result has been approved/executed (an executed approval request). */
  resultApproved: boolean;
}

export interface FirstRunStep {
  key: FirstRunStepKey;
  done: boolean;
}

/** The four setup steps in order, each with its derived done-state. Pure + total. */
export function deriveFirstRunChecklist(s: FirstRunSignals): FirstRunStep[] {
  return [
    { key: "brand", done: s.brandSet },
    { key: "connect", done: s.hasConnection },
    { key: "run", done: s.agentRan },
    { key: "approve", done: s.resultApproved },
  ];
}

/** Progress as done/total, for the "N of 4" header. */
export function firstRunProgress(steps: FirstRunStep[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.done).length, total: steps.length };
}

/** True once every step is real — the checklist has served its purpose and should not show again. */
export function firstRunComplete(steps: FirstRunStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.done);
}
