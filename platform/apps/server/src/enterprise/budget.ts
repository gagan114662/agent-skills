/**
 * Enterprise budget caps (issue #340, ADR-0340) — the PURE never-exceed decision. A budget cap is a
 * pre-committed, per-agent OR per-customer hard limit on real spend that the system NEVER crosses on its own.
 * This is the gate that BACKS bid's money caps: every department that commits real money (ad spend, paid
 * data, an email tier) asks {@link decideSpendAgainstCaps} FIRST — a spend that fits proceeds autonomously
 * inside the pre-committed envelope, but a spend that would exceed any applicable cap is BLOCKED and routed to
 * the owner through the #13 money queue under {@link ENTERPRISE_BUDGET_BREACH_ACTION}.
 *
 * Premortem (#200) encoded in the SHAPE:
 *  - **§4 irreversible money is pre-committed, never post-hoc.** The cap is the pre-commitment; crossing it is
 *    never autonomous — `decideSpendAgainstCaps` can only ALLOW-within or BLOCK-and-escalate, there is no
 *    third "spend over it anyway" path. The owner approves a breach before the money moves.
 *  - **§6 injection defense.** The decision is a pure function of NUMBERS (cap, committed, request) and
 *    structural scope keys — it never reads any provider/agent free text, so a poisoned read can never flip a
 *    gate. Every number is normalized fail-closed: a poisoned non-finite cap blocks everything; a poisoned
 *    negative committed counter clamps to 0 (it can never manufacture headroom beyond the cap); an
 *    indeterminate (NaN/Infinity) request never auto-spends.
 *
 * No IO, no clock — the committed counters are loaded by the service and the persisted store is the source of
 * truth for "what has been committed". This module only decides.
 */

import { ENTERPRISE_BUDGET_BREACH_ACTION } from "../approvals/policy.js";

/** A cap is scoped to a single customer (workspace) or a single department agent within it. */
export type BudgetScope = "customer" | "agent";

/** A pre-committed budget cap + how much has been committed against it. */
export interface BudgetCap {
  scope: BudgetScope;
  /** The workspace id (customer scope) or the agent id (agent scope) the cap applies to. */
  subjectId: string;
  /** The hard ceiling in cents the committed total may never exceed. */
  capCents: number;
  /** Cents already committed/spent against the cap (from the metering store). */
  committedCents: number;
}

/** One cap a request would breach, with exactly how far over it goes. */
export interface CapBreach {
  scope: BudgetScope;
  subjectId: string;
  capCents: number;
  committedCents: number;
  remainingCents: number;
  /** How many cents the request exceeds the remaining headroom by (> 0). */
  overByCents: number;
}

/** The verdict of checking a spend against the applicable caps. */
export interface BudgetDecision {
  /** May the spend proceed autonomously right now (it fits inside every cap)? */
  allowed: boolean;
  /** Does crossing a cap require a fresh owner decision through #13? */
  requiresOwner: boolean;
  /** The action the breach is gated under (always {@link ENTERPRISE_BUDGET_BREACH_ACTION}). */
  actionType: typeof ENTERPRISE_BUDGET_BREACH_ACTION;
  /** Every cap the request would breach (empty when allowed). */
  breaches: CapBreach[];
  reason: string;
}

/** A cap's live status — remaining headroom, utilization, and whether it is exhausted. */
export interface CapStatus {
  capCents: number;
  committedCents: number;
  remainingCents: number;
  /** Utilization in basis points (0–10000); a non-positive cap reads as fully utilized (10000). */
  utilizationBps: number;
  exhausted: boolean;
}

/** Normalize a cap ceiling fail-closed: a non-finite / negative cap becomes 0 (⇒ blocks everything). */
function normCap(capCents: number): number {
  return Number.isFinite(capCents) && capCents > 0 ? Math.trunc(capCents) : 0;
}

/**
 * Normalize a committed counter fail-closed against its (already-normalized) cap: a negative counter clamps to
 * 0 (cannot manufacture extra headroom), a non-finite counter clamps UP to the cap (⇒ zero remaining, blocks).
 */
function normCommitted(committedCents: number, capNorm: number): number {
  if (!Number.isFinite(committedCents)) return capNorm;
  return committedCents > 0 ? Math.trunc(committedCents) : 0;
}

/** The live status of a cap (remaining, utilization, exhausted). Pure + total. */
export function capStatus(cap: BudgetCap): CapStatus {
  const capCents = normCap(cap.capCents);
  const committedCents = normCommitted(cap.committedCents, capCents);
  const remainingCents = Math.max(0, capCents - committedCents);
  const utilizationBps = capCents > 0 ? Math.min(10_000, Math.round((committedCents / capCents) * 10_000)) : 10_000;
  return { capCents, committedCents, remainingCents, utilizationBps, exhausted: remainingCents <= 0 };
}

/**
 * Decide whether `requestCents` may be spent against ALL of the applicable `caps` (typically the customer cap
 * AND the spending agent's cap). Pure + total:
 *   - a non-positive request is a no-op (allowed, spends nothing);
 *   - an indeterminate request (NaN/Infinity) never auto-spends → requires the owner (#200 §6);
 *   - a request that fits inside every cap → allowed autonomously;
 *   - a request that would exceed ANY cap → blocked, `requiresOwner`, with every breaching scope reported.
 * The system never crosses a cap: there is no "allowed AND over a cap" outcome.
 */
export function decideSpendAgainstCaps(caps: readonly BudgetCap[], requestCents: number): BudgetDecision {
  const base = { actionType: ENTERPRISE_BUDGET_BREACH_ACTION };

  if (!Number.isFinite(requestCents)) {
    return {
      ...base,
      allowed: false,
      requiresOwner: true,
      breaches: [],
      reason: "indeterminate spend amount — owner approval required (never auto-spend on uncertainty)",
    };
  }
  const request = Math.trunc(requestCents);
  if (request <= 0) {
    return { ...base, allowed: true, requiresOwner: false, breaches: [], reason: "no spend requested" };
  }

  const breaches: CapBreach[] = [];
  for (const cap of caps) {
    const capCents = normCap(cap.capCents);
    const committedCents = normCommitted(cap.committedCents, capCents);
    const remainingCents = Math.max(0, capCents - committedCents);
    if (request > remainingCents) {
      breaches.push({
        scope: cap.scope,
        subjectId: cap.subjectId,
        capCents,
        committedCents,
        remainingCents,
        overByCents: request - remainingCents,
      });
    }
  }

  if (breaches.length > 0) {
    const scopes = breaches.map((b) => `${b.scope} cap (${b.subjectId})`).join(", ");
    return {
      ...base,
      allowed: false,
      requiresOwner: true,
      breaches,
      reason: `spend of ${request}¢ would exceed the ${scopes} — owner approval required`,
    };
  }
  return { ...base, allowed: true, requiresOwner: false, breaches: [], reason: "within all budget caps" };
}

/**
 * The new committed total after an ALLOWED spend is applied — clamped at the cap so the stored counter can
 * never represent an over-spend even under a buggy caller. Use only after {@link decideSpendAgainstCaps}
 * allowed the request.
 */
export function applyCommit(cap: BudgetCap, spentCents: number): number {
  const capCents = normCap(cap.capCents);
  const committedCents = normCommitted(cap.committedCents, capCents);
  const spend = Number.isFinite(spentCents) && spentCents > 0 ? Math.trunc(spentCents) : 0;
  return Math.min(capCents, committedCents + spend);
}
