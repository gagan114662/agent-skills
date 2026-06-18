/**
 * The shared agent-action contract (issue #337, ADR-0337). ONE contract every risky department-agent
 * action flows through, modeled on the "surface a PR, never an alert; verify on a live URL; flag-gated;
 * instant rollback" pattern. It makes the #200 premortem guarantees the platform default instead of a
 * per-issue afterthought.
 *
 * The lifecycle is a pure state machine:
 *
 *   observe → investigate → propose (PR/diff) → awaiting_approval (#13) → approved → applied → verified
 *                                                                       ↘ rejected (terminal)
 *                                                          applied → failed → rolled_back
 *
 * Five invariants are encoded HERE, structurally — not by agent goodwill or convention:
 *
 *  1. **Propose, never auto-apply.** A contract opens in `propose`. The ONLY transition into `applied` is
 *     {@link applyApproved}, which requires an `approved` phase. There is no observe→apply edge.
 *
 *  2. **Approval gating reuses the #13 queue.** {@link gateProposal} delegates to the existing
 *     `evaluatePolicy` (approvals/policy.ts) — NOT a parallel approval path — and force-gates every
 *     IRREVERSIBLE capability (#200 §4) on top of the money predicate.
 *
 *  3. **OFF by default behind a flag, owner-workspace-first.** An IRREVERSIBLE apply additionally requires
 *     `flags.applyIrreversible` (see flags.ts). A deployment that sets nothing applies nothing.
 *
 *  4. **No success without an external receipt.** {@link confirmVerified} reaches `verified` ONLY with a
 *     production-grounded {@link ExternalReceipt} (a live URL probe / a real read-back). Never assume success.
 *
 *  5. **Injection defense.** Investigated/fetched content is UNTRUSTED DATA. The proposal's `capability`
 *     and `reversibility` come PURELY from the structural {@link Observation} (the agent's actual tool/route);
 *     investigated content is carried only as sanitized, quarantined evidence and can never set the action
 *     type, the reversibility, or the approval (#200 §6).
 *
 * Pure + dependency-free (the only import is the pure `approvals/policy.ts` it reuses), so it runs in the
 * no-DB/no-network unit job and is the single source of truth for "did this action follow the contract?".
 */

import {
  evaluatePolicy,
  type ActionDescriptor,
  type PolicyDecision,
  type PolicyRule,
} from "../approvals/policy.js";
import { isExternalReceipt, type ExternalReceipt } from "./receipt.js";
import { canApply, type ActionContractFlags } from "./flags.js";

export type { ActionContractFlags } from "./flags.js";
export { ACTION_CONTRACT_FLAGS_OFF, resolveActionContractFlags, canApply } from "./flags.js";
export { isExternalReceipt } from "./receipt.js";
export type { ExternalReceipt } from "./receipt.js";

/**
 * The reversibility class of a capability (premortem #200 §4). `reversible` — undoable cheaply (a page
 * can be unpublished). `cheap` — a small, bounded, low-blast-radius change. `irreversible` — deliverability,
 * brand, legal, money: cannot be un-rung, so it carries the strictest guards (its own flag + a rollback plan).
 */
export const REVERSIBILITY_CLASSES = ["reversible", "cheap", "irreversible"] as const;
export type ReversibilityClass = (typeof REVERSIBILITY_CLASSES)[number];

/** The lifecycle phases of a contract. The terminal set is `verified | rejected | rolled_back`. */
export const CONTRACT_PHASES = [
  "propose",
  "awaiting_approval",
  "approved",
  "applied",
  "verified",
  "failed",
  "rejected",
  "rolled_back",
] as const;
export type ContractPhase = (typeof CONTRACT_PHASES)[number];

/** Terminal phases — a contract here never transitions again. */
export const TERMINAL_PHASES: readonly ContractPhase[] = ["verified", "rejected", "rolled_back"];

/**
 * The STRUCTURAL observation — what the agent's actual tool/route is about to do. This is the ONLY source
 * of the action's `capability` and `reversibility`. It is produced from the agent's own tool invocation,
 * never parsed out of fetched content (that is the injection boundary, #200 §6).
 */
export interface Observation {
  workspaceId: string;
  /** The structural action type (e.g. `deploy.cutover`, `content.publish`). Drives the #13 gate + routing. */
  capability: string;
  reversibility: ReversibilityClass;
  /** A short human label for the decision queue card. */
  summary: string;
}

/**
 * Content the agent investigated/fetched (a web page, a competitor site, a search result). UNTRUSTED DATA:
 * it is evidence for the human reviewer, never authority. A poisoned read folded in here can NEVER set the
 * capability, flip the reversibility, or self-approve the action (#200 §6).
 */
export interface InvestigatedContent {
  text: string;
  sourceUrl?: string;
}

/**
 * A proposed change — a PR/diff that is NEVER auto-applied. It is the artifact the owner reviews in the #13
 * queue. `rollbackPlan` is mandatory for an irreversible capability (there is no irreversible apply without
 * a way back). `evidence` is the sanitized, quarantined investigated content (DATA only).
 */
export interface ActionProposal {
  workspaceId: string;
  capability: string;
  reversibility: ReversibilityClass;
  /** The proposed change as a unified diff — reviewed, never executed by the contract. */
  diff: string;
  /** The PR/branch ref the change lives on (never the default branch). */
  prRef: string;
  summary: string;
  /** Mandatory for an irreversible capability; the documented way to undo the apply. Null only when reversible. */
  rollbackPlan: string | null;
  /** Sanitized, quarantined investigated content surfaced as evidence for the reviewer. Null when none. */
  evidence: string | null;
}

/** A contract instance — the state machine record threaded through the lifecycle. */
export interface ActionContract {
  phase: ContractPhase;
  proposal: ActionProposal;
  /** THE tie to the #13 queue — the approval request id this contract parks against. Null until submitted. */
  approvalRequestId: string | null;
  /** The production-grounded receipt that proved success. Null until verified. */
  receipt: ExternalReceipt | null;
  /** Every phase the contract has occupied, in order — the audit trail. */
  history: ContractPhase[];
}

/** A transition result: the new contract on success, or a reason it was refused. */
export type ContractTransition =
  | { ok: true; contract: ActionContract }
  | { ok: false; reason: string };

// ───────────────────────────── sanitization (injection boundary) ─────────────────────────────

/**
 * Strip control characters from untrusted investigated content before it is carried as evidence (#200 §6).
 * Uses a charCode scan (NOT a control-char regex — `no-control-regex` would reject the literal) so the
 * evidence can be safely rendered on the decision card. The content is DATA; this neither parses nor trusts it.
 */
function sanitizeEvidence(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // keep tab (9) / newline (10) / carriage-return (13); drop other C0/C1 control chars.
    const isAllowedWhitespace = code === 9 || code === 10 || code === 13;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (isControl && !isAllowedWhitespace) continue;
    out += text[i];
  }
  return out.trim();
}

// ───────────────────────────── propose (never auto-apply) ─────────────────────────────

/**
 * Build a proposal from a STRUCTURAL observation. The `capability` and `reversibility` are copied from the
 * observation ONLY — the optional `investigation` is sanitized and carried as quarantined evidence, and is
 * NEVER read to decide the action type, the reversibility, or approval (#200 §6). An irreversible capability
 * MUST be given a `rollbackPlan`; omitting it throws (an irreversible action without a way back is a bug).
 *
 * This is the ONLY constructor of a proposal, and a proposal is the ONLY thing the contract can open — so a
 * risky action can never bypass the PR/diff step into an apply.
 */
export function proposeAction(input: {
  observation: Observation;
  investigation?: InvestigatedContent;
  diff: string;
  prRef: string;
  rollbackPlan?: string | null;
}): ActionProposal {
  const { observation } = input;
  const rollbackPlan = input.rollbackPlan ?? null;
  if (observation.reversibility === "irreversible" && (rollbackPlan === null || rollbackPlan.trim() === "")) {
    throw new Error("an irreversible capability requires a rollback plan before it can be proposed");
  }
  const evidence =
    input.investigation && input.investigation.text.trim() !== ""
      ? sanitizeEvidence(input.investigation.text)
      : null;
  return {
    workspaceId: observation.workspaceId,
    capability: observation.capability, // STRUCTURAL — never from investigated content
    reversibility: observation.reversibility, // STRUCTURAL — never from investigated content
    diff: input.diff,
    prRef: input.prRef,
    summary: observation.summary,
    rollbackPlan,
    evidence,
  };
}

/** Open a contract from a proposal — it always starts in `propose`, with no approval and no receipt. */
export function openContract(proposal: ActionProposal): ActionContract {
  return { phase: "propose", proposal, approvalRequestId: null, receipt: null, history: ["propose"] };
}

// ───────────────────────────── approval gating (reuses #13) ─────────────────────────────

/**
 * Decide whether a proposal must pause for a human, REUSING the existing #13 policy engine (no parallel
 * path). It maps the proposal to an {@link ActionDescriptor} and runs `evaluatePolicy`; on top of that it
 * force-gates every IRREVERSIBLE capability (#200 §4) even when the action spends no money — an irreversible
 * action is always the owner's call. A reversible, money-free capability stays autonomous under the
 * money-only policy (#243).
 */
export function gateProposal(proposal: ActionProposal, rules: PolicyRule[]): PolicyDecision {
  const descriptor: ActionDescriptor = { actionType: proposal.capability };
  const base = evaluatePolicy(descriptor, rules);
  if (base.requiresApproval) return base;
  if (proposal.reversibility === "irreversible") {
    return {
      requiresApproval: true,
      reason: `${proposal.capability} is irreversible — owner approval required (premortem #200 §4)`,
    };
  }
  return base;
}

// ───────────────────────────── lifecycle transitions ─────────────────────────────

function advance(contract: ActionContract, phase: ContractPhase, patch?: Partial<ActionContract>): ContractTransition {
  return {
    ok: true,
    contract: { ...contract, ...patch, phase, history: [...contract.history, phase] },
  };
}

/**
 * Park the proposal in the #13 queue: `propose → awaiting_approval`. Requires a real `approvalRequestId`
 * (the row the human decides on) — an empty id is refused so a contract can never "await" a gate that does
 * not exist. This is the tie between the contract and the existing approval queue.
 */
export function submitForApproval(
  contract: ActionContract,
  input: { approvalRequestId: string },
): ContractTransition {
  if (contract.phase !== "propose") {
    return { ok: false, reason: `cannot submit for approval from phase '${contract.phase}'` };
  }
  if (input.approvalRequestId.trim() === "") {
    return { ok: false, reason: "an approval request id is required to park against the #13 queue" };
  }
  return advance(contract, "awaiting_approval", { approvalRequestId: input.approvalRequestId });
}

/**
 * Record the owner's #13 decision: `awaiting_approval → approved | rejected`. The contract NEVER decides
 * this itself — the verdict comes from the human in the queue. A rejection is terminal: the action never
 * applies.
 */
export function recordApprovalDecision(
  contract: ActionContract,
  input: { approved: boolean },
): ContractTransition {
  if (contract.phase !== "awaiting_approval") {
    return { ok: false, reason: `cannot record an approval decision from phase '${contract.phase}'` };
  }
  return advance(contract, input.approved ? "approved" : "rejected");
}

/**
 * Apply the approved change: `approved → applied`. Gated three ways, structurally:
 *   - the contract MUST be in `approved` (never `propose` — propose-not-apply),
 *   - it MUST carry an `approvalRequestId` (the human's #13 yes),
 *   - `canApply(flags, reversibility)` MUST hold (the master flag on, and the irreversible flag on for an
 *     irreversible capability) — OFF by default.
 * Any failure returns `{ ok:false }` and the contract does NOT advance. Apply performs no side effect here;
 * a real actuator behind this seam is a deliberate per-capability follow-up (this slice is build + PR only).
 */
export function applyApproved(contract: ActionContract, flags: ActionContractFlags): ContractTransition {
  if (contract.phase !== "approved") {
    return { ok: false, reason: `cannot apply: contract is '${contract.phase}', not approved` };
  }
  if (contract.approvalRequestId === null || contract.approvalRequestId.trim() === "") {
    return { ok: false, reason: "cannot apply: no #13 approval request id on the contract" };
  }
  if (!canApply(flags, contract.proposal.reversibility)) {
    return {
      ok: false,
      reason:
        contract.proposal.reversibility === "irreversible"
          ? "cannot apply: irreversible apply is disabled (flag off by default)"
          : "cannot apply: the action contract is disabled for this workspace",
    };
  }
  return advance(contract, "applied");
}

/**
 * Confirm success: `applied → verified` — ONLY with a production-grounded {@link ExternalReceipt}. Never
 * assume success (#200 §2/§3): a missing, self-reported, or unreachable receipt is refused and the contract
 * stays `applied` (the caller should then verify-fail + roll back). The receipt is stored as the proof.
 */
export function confirmVerified(contract: ActionContract, receipt: ExternalReceipt): ContractTransition {
  if (contract.phase !== "applied") {
    return { ok: false, reason: `cannot verify: contract is '${contract.phase}', not applied` };
  }
  if (!isExternalReceipt(receipt)) {
    return {
      ok: false,
      reason: "cannot verify: no production-grounded external receipt (live URL / real read-back) — never assume success",
    };
  }
  return advance(contract, "verified", { receipt });
}

/** Mark a verify as failed: `applied → failed`. The caller must then {@link rollback}. */
export function markVerifyFailed(contract: ActionContract, _reason: string): ContractTransition {
  if (contract.phase !== "applied") {
    return { ok: false, reason: `cannot fail-verify: contract is '${contract.phase}', not applied` };
  }
  return advance(contract, "failed");
}

/**
 * Roll back an applied/failed change: `applied | failed → rolled_back`. Always available after apply — the
 * fast, cheap reversal half of "bounded blast radius + fast detection + cheap reversal" (#200 §4). An
 * optional receipt records the production-grounded proof the rollback itself reached reality.
 */
export function rollback(contract: ActionContract, receipt?: ExternalReceipt): ContractTransition {
  if (contract.phase !== "applied" && contract.phase !== "failed") {
    return { ok: false, reason: `cannot roll back from phase '${contract.phase}'` };
  }
  const patch = receipt && isExternalReceipt(receipt) ? { receipt } : undefined;
  return advance(contract, "rolled_back", patch);
}

// ───────────────────────────── premortem read side ─────────────────────────────

/**
 * Summarize a set of contracts for the #200 premortem panel: how many risky actions flowed through the full
 * contract and reached `verified` WITH a production-grounded receipt, vs how many reached an apply at all.
 * This is the read-only governance gauge the weekly founder report surfaces (FM#3: verification must touch
 * reality). Pure — counts only, no estimate.
 */
export interface ContractGovernanceSummary {
  /** Contracts that reached `applied` (a real change went out under the contract). */
  applied: number;
  /** Contracts that reached `verified` with a stored external receipt (success proven against reality). */
  verifiedWithReceipt: number;
}

export function summarizeContractGovernance(contracts: ActionContract[]): ContractGovernanceSummary {
  let applied = 0;
  let verifiedWithReceipt = 0;
  for (const c of contracts) {
    const everApplied = c.history.includes("applied");
    if (everApplied) applied++;
    if (c.phase === "verified" && c.receipt !== null && isExternalReceipt(c.receipt)) {
      verifiedWithReceipt++;
    }
  }
  return { applied, verifiedWithReceipt };
}
