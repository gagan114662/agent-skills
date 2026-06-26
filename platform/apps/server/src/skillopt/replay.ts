/**
 * Production replay adapter for SkillOpt (#1063). The cycle already mines real agent runs from
 * marketing_tasks; this file supplies the missing second half: convert production outcome-verifier rows
 * into externally verified ValidationReadings keyed to those mined clusters.
 *
 * The adapter is intentionally narrow and fail-closed:
 *   - only PASSED verifier rows are eligible;
 *   - only externally grounded verifier kinds/sources are trusted;
 *   - a row must explicitly name the SkillOpt agent + cluster it validates;
 *   - no prose parsing is used. The persisted measured value is the candidate delta.
 */
import type { VerifierKind, VerifierResultRecord } from "../verifiers/types.js";
import type { ClusterCandidate } from "./cycle.js";
import { isExternalReceiptSource, type TaskCluster } from "./contract.js";
import { sanitizeForData } from "./mine.js";

const SKILLOPT_CLAIM_PREFIX = "skillopt";

type ReplayableVerifierKind = Extract<VerifierKind, "growth_metric" | "revenue_real">;

type ReplayReceipt = Pick<
  VerifierResultRecord,
  "kind" | "claimRef" | "status" | "measuredValue" | "threshold" | "source" | "createdAt"
>;

interface ReplayClaimRef {
  agentHandle: string;
  clusterKey: string;
  metric?: string;
}

export interface BuildReplayCandidatesInput {
  agentHandle: string;
  skillId: string;
  clusters: readonly TaskCluster[];
  receipts: readonly ReplayReceipt[];
}

/**
 * Build per-cluster replay candidates from verifier receipts. Receipts should be newest-first; the first
 * eligible receipt for a cluster wins so a recent measurement supersedes older evidence.
 */
export function buildReplayCandidatesFromVerifierReceipts(
  input: BuildReplayCandidatesInput,
): ClusterCandidate[] {
  const clustersByKey = new Map(input.clusters.map((cluster) => [cluster.key, cluster]));
  const used = new Set<string>();
  const candidates: ClusterCandidate[] = [];

  for (const receipt of input.receipts) {
    if (receipt.status !== "passed") continue;
    if (!isReplayableKind(receipt.kind)) continue;
    if (!isExternalVerifierReceipt(receipt)) continue;
    if (!(receipt.measuredValue > 0)) continue;

    const ref = parseReplayClaimRef(receipt.claimRef);
    if (!ref || ref.agentHandle !== input.agentHandle) continue;
    const cluster = clustersByKey.get(ref.clusterKey);
    if (!cluster || used.has(cluster.key)) continue;

    used.add(cluster.key);
    candidates.push({
      clusterKey: cluster.key,
      validation: {
        metric: replayMetricId(receipt, ref),
        higherIsBetter: true,
        baseline: 0,
        candidate: receipt.measuredValue,
        sampleSize: cluster.sampleIds.length,
        externallyVerified: true,
      },
      proposedAppendText: renderReplayAppend(input.agentHandle, input.skillId, cluster, receipt, ref),
    });
  }

  return candidates;
}

/**
 * Claim refs accepted by production replay:
 *   - skillopt:<agentHandle>:<urlencoded clusterKey>
 *   - skillopt:<agentHandle>:<urlencoded clusterKey>:<metric>
 *
 * The explicit prefix prevents unrelated verifier rows from accidentally teaching SkillOpt.
 */
export function parseReplayClaimRef(claimRef: string): ReplayClaimRef | null {
  const parts = claimRef.split(":");
  if (parts.length < 3 || parts[0] !== SKILLOPT_CLAIM_PREFIX) return null;
  const agentHandle = decodePart(parts[1]);
  const clusterKey = decodePart(parts[2]);
  const metric = parts[3] ? decodePart(parts.slice(3).join(":")) : undefined;
  if (!agentHandle || !clusterKey) return null;
  return { agentHandle, clusterKey, metric };
}

function decodePart(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isReplayableKind(kind: VerifierKind): kind is ReplayableVerifierKind {
  return kind === "growth_metric" || kind === "revenue_real";
}

function isExternalVerifierReceipt(receipt: ReplayReceipt): boolean {
  if (receipt.kind === "revenue_real") return true; // #98 settled revenue verifier, not a fake-door click.
  if (!receipt.source) return false;
  return isExternalReceiptSource(receipt.source);
}

function replayMetricId(receipt: ReplayReceipt, ref: ReplayClaimRef): string {
  if (ref.metric) return sanitizeForData(ref.metric, 80) || "verifier." + receipt.kind;
  return receipt.kind === "revenue_real" ? "revenue.settled_events" : "growth.verified_delta";
}

function renderReplayAppend(
  agentHandle: string,
  skillId: string,
  cluster: TaskCluster,
  receipt: ReplayReceipt,
  ref: ReplayClaimRef,
): string {
  const metric = replayMetricId(receipt, ref);
  const task = sanitizeForData(cluster.representativeTask, 180);
  const source = sanitizeForData(receipt.source ?? receipt.kind, 80);
  return [
    "## SkillOpt lesson: " + task,
    "When @" +
      agentHandle +
      " handles this recurring task, start from the externally verified " +
      metric +
      " receipt before drafting changes.",
    "Receipt source: " +
      source +
      "; verified lift: " +
      receipt.measuredValue +
      "; samples: " +
      cluster.sampleIds.length +
      "; skill: " +
      skillId +
      ".",
  ].join("\n");
}

export type { ReplayReceipt };
