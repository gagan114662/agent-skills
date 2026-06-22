/**
 * The mandatory pre-publish gate (issue #627) — combines the brand-voice check (`voice.ts`) and the
 * factual-accuracy check (`facts.ts`) into ONE decision a caller must consult before any outbound/public
 * action: publishing a post, sending an email, posting to social, shipping a landing page.
 *
 * Acceptance (#627): "content failing brand or fact checks is blocked from publishing and routed back for
 * revision." This file is where that happens. {@link gatePublish} returns `allowed: false` with a concrete
 * list of revision notes whenever the draft is off-brand or carries unsourced claims; only a draft that
 * passes BOTH checks (and is non-empty) is `allowed: true`.
 *
 * Invariants encoded in the SHAPE (mirrors the content-guard gate, #674):
 *  - **Additive / one-directional.** The gate can only ever BLOCK. There is no input that turns a failing
 *    draft into `allowed`. It tightens, never loosens, what may ship.
 *  - **Fail-closed.** An empty / whitespace / non-string draft is `allowed: false` ("nothing to publish").
 *    Uncertainty resolves to "revise", never to "ship".
 *  - **Mandatory + on by default.** Enforcement is not switch-off-able; only the strictness thresholds are
 *    tunable (see `caps.ts`), and they can only be made stricter or relaxed down to "still blocks hard
 *    failures", never to autopilot.
 *  - **Structural decisions only.** The verdict reads scores, severities and counts — never re-interprets the
 *    draft prose as instructions (#200 FM#6).
 *
 * Pure + total: no IO, no clock. The caller persists nothing here; on `allowed: false` it routes the draft
 * back to the authoring agent with {@link PublishDecision.revisionNotes} and does NOT perform the public
 * action. On `allowed: true` the action proceeds under the caller's normal policy (e.g. the #13 approval
 * queue for sends) — this gate is an additional precondition, not a replacement for it.
 */

import { checkBrandVoice, type BrandVoiceProfile, type VoiceResult } from "./voice.js";
import { checkFactualClaims, type FactResult } from "./facts.js";

/** The gate's verdict family. */
export type PublishOutcome =
  /** Clean on both axes — may proceed to publish (subject to the caller's own downstream policy). */
  | "pass"
  /** Off-brand and/or carries unsourced claims — blocked from publishing and routed back for revision. */
  | "revise";

/** Why a draft was blocked. `empty` is the fail-closed case (no content at all). */
export type FailReason = "voice" | "facts" | "empty";

/** Strictness knobs for the gate (resolved from env in `caps.ts`). */
export interface PublishGatePolicy {
  /** A draft scoring below this brand-voice floor is blocked. */
  minVoiceScore: number;
  /** A high-severity brand-voice finding (banned phrase, clickbait, false guarantee) always blocks. */
  blockOnHighSeverityVoice: boolean;
  /** A high-severity unsourced claim (a hard stat or "studies show" with no citation) always blocks. */
  blockOnHighSeverityFact: boolean;
  /** Maximum number of unsourced claims of ANY severity tolerated before blocking. 0 = any unsourced claim blocks. */
  maxUnsourcedClaims: number;
}

/** Sensible, strict-by-default policy. The default a workspace gets with no env overrides. */
export const DEFAULT_PUBLISH_GATE_POLICY: PublishGatePolicy = {
  minVoiceScore: 70,
  blockOnHighSeverityVoice: true,
  blockOnHighSeverityFact: true,
  maxUnsourcedClaims: 0,
};

/** Input to {@link gatePublish}: the draft plus the brand context to judge it against. */
export interface PublishCheckInput {
  /** The draft content about to go public. */
  content: string;
  /** Brand-voice rules (built-in lexicons always apply; this layers brief-derived banned phrases on top). */
  voiceProfile?: BrandVoiceProfile;
  /** Claims the brand pre-approved (the campaign brief's `brandClaims`, #588) — these need no external source. */
  approvedClaims?: string[];
}

/** The gate's verdict on a single draft. */
export interface PublishDecision {
  outcome: PublishOutcome;
  /** Convenience: `true` only for `pass`. The caller MUST NOT publish when this is `false`. */
  allowed: boolean;
  /** The reasons it was blocked (empty when `allowed`). */
  failed: FailReason[];
  /** The full brand-voice result, for surfacing / auditing. */
  voice: VoiceResult;
  /** The full factual-accuracy result, for surfacing / auditing. */
  facts: FactResult;
  /** A one-line human-readable summary of the verdict. */
  summary: string;
  /** Concrete, ordered instructions the authoring agent follows on a `revise` outcome (empty when allowed). */
  revisionNotes: string[];
}

/**
 * Run the mandatory pre-publish gate. Pure + total.
 *  - Empty / non-string draft ⇒ blocked (`empty`).
 *  - Voice score below the floor, OR a high-severity voice finding (when the policy blocks on it) ⇒ blocked (`voice`).
 *  - Any high-severity unsourced claim (when the policy blocks on it), OR more than `maxUnsourcedClaims`
 *    unsourced claims ⇒ blocked (`facts`).
 *  - Otherwise ⇒ `pass`.
 * There is no path from a failing draft to `allowed: true`.
 */
export function gatePublish(
  input: PublishCheckInput,
  policy: PublishGatePolicy = DEFAULT_PUBLISH_GATE_POLICY,
): PublishDecision {
  const safeInput: PublishCheckInput =
    input && typeof input === "object" ? input : { content: "" };
  const content = typeof safeInput.content === "string" ? safeInput.content : "";

  const voice = checkBrandVoice(content, safeInput.voiceProfile);
  const facts = checkFactualClaims(content, { approvedClaims: safeInput.approvedClaims });

  const failed: FailReason[] = [];
  const revisionNotes: string[] = [];

  // Fail-closed: there must be something to publish.
  if (content.trim().length === 0) {
    failed.push("empty");
    revisionNotes.push("There is no content to publish — write the draft before requesting publication.");
  }

  // --- brand-voice axis ---------------------------------------------------------------------------------
  const highVoice = voice.findings.filter((f) => f.severity === "high");
  const voiceFails =
    voice.score < policy.minVoiceScore || (policy.blockOnHighSeverityVoice && highVoice.length > 0);
  if (voiceFails && content.trim().length > 0) {
    failed.push("voice");
    if (voice.score < policy.minVoiceScore) {
      revisionNotes.push(
        `Brand-voice score ${voice.score}/${policy.minVoiceScore} is below the bar — rewrite the off-brand lines.`,
      );
    }
    for (const f of voice.findings) {
      revisionNotes.push(`Off-brand (${f.kind}): ${f.label} — e.g. "${f.excerpt}".`);
    }
  }

  // --- factual-accuracy axis ----------------------------------------------------------------------------
  const highUnsourced = facts.unsourced.filter((c) => c.severity === "high");
  const factFails =
    (policy.blockOnHighSeverityFact && highUnsourced.length > 0) ||
    facts.unsourced.length > policy.maxUnsourcedClaims;
  if (factFails) {
    failed.push("facts");
    for (const c of facts.unsourced) {
      revisionNotes.push(
        `Unsourced ${c.kind} claim — add a citation/source or remove it: "${c.sentence}".`,
      );
    }
  }

  const allowed = failed.length === 0;
  return {
    outcome: allowed ? "pass" : "revise",
    allowed,
    failed,
    voice,
    facts,
    summary: summarize(allowed, failed, voice, facts),
    revisionNotes,
  };
}

function summarize(
  allowed: boolean,
  failed: readonly FailReason[],
  voice: VoiceResult,
  facts: FactResult,
): string {
  if (allowed) {
    return `Pass: on-brand (voice ${voice.score}/100) and all ${facts.claims.length} factual claim(s) sourced — cleared to publish.`;
  }
  const parts: string[] = [];
  if (failed.includes("empty")) parts.push("nothing to publish");
  if (failed.includes("voice")) parts.push(`off-brand (voice ${voice.score}/100, ${voice.findings.length} issue(s))`);
  if (failed.includes("facts")) parts.push(`${facts.unsourced.length} unsourced claim(s)`);
  return `Blocked — ${parts.join("; ")}. Routed back for revision.`;
}
