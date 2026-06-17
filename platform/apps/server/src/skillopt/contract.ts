/**
 * SkillOpt-Sleep contract (#283, ADR-0283) — the **pure**, dependency-free source of truth for the
 * department-agent self-improvement loop (per microsoft/SkillOpt): each named fleet agent
 * (scout/echo/quill/postmark/bid/lens/mark/comet) gets an offline cycle that harvests its own session
 * transcripts, mines the tasks it keeps being asked to do, replays them, and proposes a **bounded** edit to
 * its own skill doc — accepted only when a held-out validation gate **strictly improves** on
 * **externally-verified** receipts. Every proposal is STAGED in the #13 approval queue for the owner to
 * adopt; the loop NEVER edits a skill doc itself.
 *
 * This module is the stable consumer surface (mirrors `discovery/contract.ts`, `agent-registry/contract.ts`):
 * types + the #13 action id only, no IO. The premortem (#200) is honored in the type design:
 *   - §2 self-reported metrics are fiction → a {@link ValidationReading} carries `externallyVerified`; the
 *     gate ({@link import("./gate.js")}) refuses to adopt on an unverified reading.
 *   - §4 reversibility → a {@link SkillEditProposal} is APPEND-ONLY and pins `currentDocSha`, so adoption is
 *     a cheap, reversible, auditable diff (and applies only if the doc is unchanged).
 *   - §6 injection defense → every harvested text is DATA, sanitized before it is ever surfaced (see
 *     `mine.ts`/`propose.ts`); a proposed edit that tries to weaken the draft-only/approval contract is
 *     rejected, never staged.
 */

/** The fleet @handle the cycle improves (e.g. `scout`). The agent's stable id (see agent-registry). */
export type AgentHandle = string;

/**
 * One harvested session transcript, reduced to the loop's inputs. Every field is **DATA** — the loop reads
 * it, it never executes it (injection defense, #200 §6). `succeeded` is the session's own terminal status
 * (used only to weight mining); it is NOT a quality metric — quality is judged exclusively by
 * external receipts in the validation gate.
 */
export interface TranscriptSample {
  /** Stable id of the source session/transcript (for traceability; never surfaced as an instruction). */
  sampleId: string;
  workspaceId: string;
  /** The fleet agent that ran this session. */
  agentHandle: AgentHandle;
  /** The task the agent was briefed with — DATA, sanitized before use. */
  taskText: string;
  /** Whether the session reached a successful terminal state (mining weight only, not a metric). */
  succeeded: boolean;
}

/** A mined recurring-task pattern: tasks that normalize to the same shape, with how often they recur. */
export interface TaskCluster {
  /** The normalized clustering key (lowercased, stripped of volatile tokens — see `normalizeTaskText`). */
  key: string;
  /** A sanitized, human-readable exemplar of the cluster (the first sample's text, capped). */
  representativeTask: string;
  /** How many harvested samples fall in this cluster. */
  count: number;
  /** The source sample ids in this cluster (traceability). */
  sampleIds: string[];
}

/**
 * The set of receipt sources that count as **external / third-party** (#200 §2) — money, delivery, and
 * analytics events that originate OUTSIDE the agent's own report. A reading sourced from anywhere else is
 * self-reported fiction and can never drive adoption.
 */
export const EXTERNAL_RECEIPT_SOURCES = [
  "stripe", // payment events (revenue, conversions)
  "delivery_webhook", // ESP/social delivery + engagement webhooks (#189/#295)
  "analytics", // product analytics funnel (#102)
  "search_console", // Google Search Console / rank receipts (#294)
  "rank_provider", // a third-party rank provider receipt
] as const;
export type ExternalReceiptSource = (typeof EXTERNAL_RECEIPT_SOURCES)[number];

/** True iff `source` is an external/third-party receipt source (the only kind the gate trusts). Pure + total. */
export function isExternalReceiptSource(source: string): source is ExternalReceiptSource {
  return (EXTERNAL_RECEIPT_SOURCES as readonly string[]).includes(source);
}

/**
 * A held-out validation reading: the same metric measured on a held-out replay set under the BASELINE skill
 * doc vs the CANDIDATE (proposed) skill doc, from external receipts only. `higherIsBetter` orients the
 * comparison (e.g. conversions higherIsBetter; CAC lower-is-better). `externallyVerified` MUST be true for
 * the gate to consider it (premortem #200 §2) — it is sourced from {@link ExternalReceiptSource} receipts.
 */
export interface ValidationReading {
  /** The metric id (e.g. `seo.click_through`, `email.reply_rate`). */
  metric: string;
  /** Whether a higher value is better (false ⇒ lower-is-better, e.g. CAC). */
  higherIsBetter: boolean;
  /** The metric under the current (baseline) skill doc, from external receipts. */
  baseline: number;
  /** The metric under the candidate (proposed) skill doc, from external receipts. */
  candidate: number;
  /** Size of the held-out replay set behind the reading (a tiny set is rejected by the gate). */
  sampleSize: number;
  /** True iff both readings come from external/third-party receipts. The gate refuses adoption otherwise. */
  externallyVerified: boolean;
}

/**
 * A staged, BOUNDED proposal to improve one agent's skill doc. The loop produces this and parks it in the
 * #13 queue; the owner adopts it (or not). It is **append-only** (the loop never removes or rewrites an
 * existing line — so the draft-only/approval safety lines can never be deleted) and pins `currentDocSha`
 * so adoption is reversible + applies only to the exact doc it was validated against.
 */
export interface SkillEditProposal {
  agentHandle: AgentHandle;
  /** The skill doc id this edit targets (e.g. `scout/runbook`, from the agent's skill kit #155). */
  skillId: string;
  /** Content hash of the skill doc the proposal was built + validated against (reversibility/audit). */
  currentDocSha: string;
  /** The sanitized, bounded text to APPEND to the doc (never a rewrite). */
  appendText: string;
  /** Why this edit is proposed — the mined recurring task it addresses. */
  rationale: string;
  /** The cluster key this edit came from (traceability). */
  clusterKey: string;
  /** The held-out validation reading that justifies adoption (externally verified, strict improvement). */
  validation: ValidationReading;
}

/** The outcome of one offline cycle: either a proposal was staged, or the cycle was skipped (with reason). */
export type SkillOptCycleResult =
  | { status: "staged"; proposal: SkillEditProposal }
  | { status: "skipped"; reason: string };
