/**
 * SkillOpt-Sleep cycle decision (#283, ADR-0283) — **pure**: the whole offline loop for ONE agent as a
 * single deterministic function (harvest → mine → gate → propose), so the entire happy path AND every
 * skip branch are unit-testable without a DB. The service (`service.ts`) does the IO around this: it
 * harvests the transcripts, fetches the external validation receipts, asks the replay/draft seam for a
 * candidate append, then stages the staged proposal into the #13 queue.
 *
 * The function is fail-closed: a disabled flag, nothing recurring, a missing/unverified validation reading,
 * a non-improving gate, or an unsafe/oversized edit all return `skipped` with a reason — `staged` is
 * produced ONLY when every safety condition holds. The loop NEVER edits a doc; its output is at most a
 * proposal for the owner.
 */
import type { SkillOptCycleResult, TaskCluster, TranscriptSample, ValidationReading } from "./contract.js";
import { mineRecurringTasks, type MineOptions } from "./mine.js";
import { decideAdoption, type AdoptionGateOptions } from "./gate.js";
import { buildSkillEditProposal } from "./propose.js";

/**
 * The per-cluster candidate the replay/draft step produced for a recurring task: the held-out external
 * reading that judges it, and the bounded text it proposes to append. In this first slice these are
 * supplied to the cycle (the service's replay seam fills them); a richer replay engine is a follow-up.
 */
export interface ClusterCandidate {
  /** The cluster key this candidate answers (matches {@link TaskCluster.key}). */
  clusterKey: string;
  validation: ValidationReading;
  /** The bounded text the candidate would append to the skill doc (DATA — screened in `propose.ts`). */
  proposedAppendText: string;
}

/** Everything the pure cycle needs for ONE agent. */
export interface SkillOptCycleInput {
  /** Whether the loop is enabled for this workspace (resolved by `caps.ts`). When false ⇒ always skipped. */
  enabled: boolean;
  agentHandle: string;
  /** The skill doc id to improve (the agent's runbook, from its #155 kit). */
  skillId: string;
  /** Content hash of the current skill doc (pins the proposal for reversible adoption). */
  currentDocSha: string;
  /** Harvested transcripts (a mixed batch is fine — mining filters to `agentHandle`). */
  samples: readonly TranscriptSample[];
  /** Candidates keyed by cluster (from the replay/draft seam). A cluster with no candidate is skipped. */
  candidates: readonly ClusterCandidate[];
  mine?: MineOptions;
  gate?: AdoptionGateOptions;
  /** Max chars for the bounded append (forwarded to the proposal builder). */
  maxAppendChars?: number;
}

/**
 * Run the offline cycle for one agent and return either a staged proposal or a reasoned skip. Acts on the
 * TOP recurring cluster only (bounded surface: one improvement per cycle, the issue's "one measurable
 * improvement cycle"). Pure.
 */
export function decideSkillOptCycle(input: SkillOptCycleInput): SkillOptCycleResult {
  if (!input.enabled) {
    return { status: "skipped", reason: "skillopt disabled for this workspace" };
  }

  const clusters: TaskCluster[] = mineRecurringTasks(input.samples, input.agentHandle, input.mine);
  if (clusters.length === 0) {
    return { status: "skipped", reason: "no recurring tasks in the harvested transcripts" };
  }

  const top = clusters[0]!;
  const candidate = input.candidates.find((c) => c.clusterKey === top.key);
  if (!candidate) {
    return { status: "skipped", reason: `no replay candidate for the top recurring task "${top.key}"` };
  }

  const verdict = decideAdoption(candidate.validation, input.gate);
  if (!verdict.adopt) {
    return { status: "skipped", reason: `gate: ${verdict.reason}` };
  }

  const built = buildSkillEditProposal({
    agentHandle: input.agentHandle,
    skillId: input.skillId,
    currentDocSha: input.currentDocSha,
    cluster: top,
    validation: candidate.validation,
    proposedAppendText: candidate.proposedAppendText,
    maxAppendChars: input.maxAppendChars,
  });
  if (!built.ok) {
    return { status: "skipped", reason: `proposal: ${built.reason}` };
  }

  return { status: "staged", proposal: built.proposal };
}
