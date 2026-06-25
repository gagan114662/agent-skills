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
import {
  reweightClustersByRevenue,
  type RevenueReward,
  type ReweightOptions,
} from "../attribution/reward.js";

/**
 * The OPTIONAL revenue learning signal (#390, ADR-0390) — the "learn" step of the autonomous loop. When
 * supplied, the cycle reweights its mined recurring-task clusters by #386 attributed revenue BEFORE picking
 * the one cluster to improve, so the fleet invests its self-improvement cycle on revenue-producing work
 * ("more of what earns"). Absent (the caller leaves it unset when the `attribution` flag is OFF, or the
 * projection yields no receipts) ⇒ the cycle ranks by frequency exactly as before (byte-for-byte). The
 * "no receipts ⇒ no learning" dependency is enforced inside {@link reweightClustersByRevenue}: an empty
 * reward returns the frequency order unchanged.
 */
export interface RevenueReweight {
  reward: RevenueReward;
  options?: ReweightOptions;
}

/**
 * OPTIONAL negative learning signal (#889). When a regression can be tied to specific mined clusters, those
 * clusters are pushed behind non-regressed work before the cycle picks a candidate. When the caller only
 * knows the agent regressed but cannot safely map it to a cluster, it can provide a fail-closed blockReason.
 */
export interface EvalRegressionReweight {
  regressedClusterKeys?: readonly string[];
  blockReason?: string;
}

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
  /**
   * OPTIONAL #390 revenue learning signal. When set, the mined clusters are reweighted by attributed
   * revenue (the #386 receipts) before the top is chosen. Unset ⇒ today's frequency ordering, unchanged.
   */
  revenueReweight?: RevenueReweight;
  /**
   * OPTIONAL #889 eval-regression signal. Known regressed clusters are down-ranked; unscoped agent-level
   * regressions can block staging entirely so the loop does not reinforce a bad runbook.
   */
  evalRegressionReweight?: EvalRegressionReweight;
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

  // #390: when a revenue learning signal is supplied, reweight the frequency-ranked clusters by attributed
  // revenue so the cycle improves revenue-producing work first ("more of what earns"). With no signal — or
  // an empty reward (no receipts) — the order is unchanged, so the default (flag OFF) path is byte-for-byte
  // identical to frequency-only ranking.
  const revenueOrderedClusters: TaskCluster[] = input.revenueReweight
    ? reweightClustersByRevenue(
        clusters,
        input.revenueReweight.reward,
        input.revenueReweight.options,
      ).map((r) => r.cluster)
    : clusters;

  if (input.evalRegressionReweight?.blockReason) {
    return { status: "skipped", reason: `eval regression guard: ${input.evalRegressionReweight.blockReason}` };
  }

  const orderedClusters = downrankEvalRegressedClusters(revenueOrderedClusters, input.evalRegressionReweight);

  const top = orderedClusters[0]!;
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

function downrankEvalRegressedClusters(
  clusters: TaskCluster[],
  signal: EvalRegressionReweight | undefined,
): TaskCluster[] {
  const regressed = new Set(signal?.regressedClusterKeys ?? []);
  if (regressed.size === 0) return clusters;
  return [...clusters].sort((a, b) => {
    const aRegressed = regressed.has(a.key);
    const bRegressed = regressed.has(b.key);
    if (aRegressed === bRegressed) return 0;
    return aRegressed ? 1 : -1;
  });
}
