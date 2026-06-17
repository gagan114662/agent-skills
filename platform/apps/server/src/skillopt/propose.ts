/**
 * SkillOpt-Sleep proposal builder (#283, ADR-0283) — **pure**: turn a validated candidate into a BOUNDED,
 * injection-safe skill-edit proposal the owner can adopt through #13. The bounds ARE the safety model
 * (premortem #200 §4 reversibility, §6 injection defense):
 *   - APPEND-ONLY: the loop can only add a section; it can never rewrite or delete an existing line, so the
 *     draft-only / approval / "made by robots, steered by humans" safety lines of a skill doc are
 *     structurally un-removable by the loop.
 *   - SIZE-CAPPED: a proposed append is capped, so a single cycle can never balloon a skill doc.
 *   - CONTENT-SCREENED: an append that tries to weaken the draft-only/approval contract, or smuggle an
 *     instruction / tool directive, is REJECTED — never staged. The mined text is DATA, not a command.
 *   - SHA-PINNED: the proposal pins the doc's content hash, so adoption is a cheap reversible diff that
 *     applies only to the exact doc it was validated against.
 * No IO; deterministic ⇒ unit-testable.
 */
import type { SkillEditProposal, TaskCluster, ValidationReading } from "./contract.js";
import { sanitizeForData } from "./mine.js";

/** Default ceiling on a single proposed append (chars). One cycle adds at most a short section. */
const MAX_APPEND_CHARS = 600;

/**
 * Phrases that signal an attempt to weaken the agent's safety contract or inject an instruction. An append
 * matching any of these is rejected outright (case-insensitive). This is a denylist of EDIT INTENT, not a
 * content filter — it guards the one thing the loop must never do: quietly remove the human gate. Kept
 * deliberately broad on the approval/send/spend axis.
 */
const UNSAFE_EDIT_PATTERNS: readonly RegExp[] = [
  /ignore (all |the |previous |above )?(instructions|rules|guidance)/i,
  /disregard (the |all |previous )?/i,
  /without (owner |human |a human )?(approval|review|sign-?off)/i,
  /(skip|bypass|remove|disable|drop|delete) (the )?(approval|review|human|gate|safety|draft-only)/i,
  /no (approval|review|human) (needed|required|necessary)/i,
  /you (may|can|should) (now )?(send|post|publish|spend|charge|pay|wire)/i,
  /auto-?(send|post|publish|approve|spend)/i,
  /system ?prompt|<\/?(system|tool|function)\b|tool_call|assistant:/i,
];

/** True iff `text` contains content that would weaken the safety contract or smuggle an instruction. Pure. */
export function containsUnsafeEditContent(text: string): boolean {
  return UNSAFE_EDIT_PATTERNS.some((re) => re.test(text));
}

/** Render the full doc that adopting the proposal would produce — append-only, for owner preview. Pure. */
export function renderProposedDoc(currentDocText: string, appendText: string): string {
  return `${currentDocText.replace(/\s+$/, "")}\n\n${appendText.trim()}\n`;
}

/** Inputs to {@link buildSkillEditProposal}. `currentDocSha` is the hash the caller already computed. */
export interface BuildProposalInput {
  agentHandle: string;
  skillId: string;
  currentDocSha: string;
  cluster: TaskCluster;
  validation: ValidationReading;
  /** The candidate text the replay/draft step produced (DATA — sanitized + screened here). */
  proposedAppendText: string;
  /** Max chars for the bounded append (default {@link MAX_APPEND_CHARS}). */
  maxAppendChars?: number;
}

/** A rejected build carries a reason (so the cycle can record WHY a candidate was not staged). */
export type BuildProposalResult =
  | { ok: true; proposal: SkillEditProposal }
  | { ok: false; reason: string };

/**
 * Build a bounded, injection-safe proposal — or reject it with a reason. The caller has already passed the
 * adoption gate; this enforces the EDIT-shape invariants. Pure + total.
 */
export function buildSkillEditProposal(input: BuildProposalInput): BuildProposalResult {
  const maxAppendChars = input.maxAppendChars ?? MAX_APPEND_CHARS;
  const appendText = sanitizeForData(input.proposedAppendText, maxAppendChars + 1);

  if (appendText.length === 0) {
    return { ok: false, reason: "proposed edit is empty after sanitization" };
  }
  if (appendText.length > maxAppendChars) {
    return { ok: false, reason: `proposed edit exceeds the bounded size (${maxAppendChars} chars)` };
  }
  if (containsUnsafeEditContent(appendText)) {
    return {
      ok: false,
      reason: "proposed edit would weaken the draft-only/approval contract or inject an instruction — rejected",
    };
  }

  const rationale =
    `@${input.agentHandle} was briefed "${input.cluster.representativeTask}" ${input.cluster.count}× — ` +
    `this edit captures the pattern; it strictly improved ${input.validation.metric} on a held-out, ` +
    `externally-verified replay.`;

  return {
    ok: true,
    proposal: {
      agentHandle: input.agentHandle,
      skillId: input.skillId,
      currentDocSha: input.currentDocSha,
      appendText,
      rationale: sanitizeForData(rationale, 600),
      clusterKey: input.cluster.key,
      validation: input.validation,
    },
  };
}
