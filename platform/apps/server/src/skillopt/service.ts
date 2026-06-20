/**
 * SkillOpt-Sleep service (#283, ADR-0283) — the IO orchestrator that runs the offline self-improvement
 * cycle for a workspace's fleet and STAGES any resulting proposal in the #13 queue. It owns **no new
 * authority**: the pure {@link decideSkillOptCycle} makes every decision, and a staged proposal is parked
 * as a PENDING `skillopt.adopt_skill_edit` request the owner adopts (or not) — the loop never edits a doc.
 *
 * Every side effect is one injected seam, so the service runs against fakes in unit tests and real repos in
 * `default.ts` (mirrors `agent-registry/service.ts`, `outreach/service.ts`). The gate is enforced here:
 * when the loop is disabled for a workspace, the service does nothing (default OFF, owner-workspace-first).
 */
import type { SkillEditProposal, SkillOptCycleResult, TaskCluster, TranscriptSample } from "./contract.js";
import { mineRecurringTasks } from "./mine.js";
import { decideSkillOptCycle, type ClusterCandidate, type RevenueReweight } from "./cycle.js";
import { isSkillOptEnabledForWorkspace, type SkillOptCaps } from "./caps.js";
import type { RevenueReward } from "../attribution/reward.js";

/** Identity the cycle runs as: the workspace + the member a staged #13 request is attributed to. */
export interface SkillOptIdentity {
  workspaceId: string;
  /** The member id a staged proposal is requested as (the owner/system actor). */
  requesterMemberId: string;
}

/** One fleet agent the loop improves: its @handle + the skill doc id (its runbook from the #155 kit). */
export interface SkillOptAgentTarget {
  handle: string;
  skillId: string;
}

/** The current skill doc the proposal is built + validated against. */
export interface SkillDocSnapshot {
  /** Content hash of the doc (pins the proposal for reversible adoption). */
  sha: string;
  text: string;
}

export interface SkillOptDeps {
  /** Resolve the per-workspace caps (the flag + owner-first + gate bounds). */
  caps(workspaceId: string): SkillOptCaps;
  /** The fleet agents (handle + skill doc id) eligible for self-improvement. */
  agents(): SkillOptAgentTarget[];
  /** Harvest recent session transcripts for one agent (DATA — the loop never executes them). */
  harvest(workspaceId: string, agentHandle: string): Promise<TranscriptSample[]>;
  /** Load the current skill doc (text + content sha) for an agent's skill id. */
  loadSkillDoc(skillId: string): Promise<SkillDocSnapshot>;
  /**
   * The replay/draft seam — produce candidate edits with held-out, externally-verified readings for the
   * mined clusters. In this first slice the production default returns `[]` (so nothing is ever staged
   * without a real replay), and unit tests inject fakes. A real replay engine (real spawns, real receipts)
   * is the deliberate follow-up.
   */
  replay(input: {
    workspaceId: string;
    agentHandle: string;
    skillId: string;
    clusters: TaskCluster[];
  }): Promise<ClusterCandidate[]>;
  /** Park a staged proposal as a PENDING #13 request; returns the request id. */
  stage(input: {
    workspaceId: string;
    requesterMemberId: string;
    proposal: SkillEditProposal;
  }): Promise<{ id: string }>;
  /**
   * OPTIONAL #390 revenue learning seam (ADR-0390). Build the live revenue reward for a workspace from the
   * #386 attributed-revenue projection, so the cycle reweights its frequency-ranked clusters toward the work
   * that earns ("more of what earns"). The default wiring (`default.ts`) supplies the real implementation,
   * gated by the `attribution` flag: it returns `null` when attribution is OFF for the workspace OR the
   * projection yields zero attributed receipts. Absent (the seam itself is unset) ⇒ no reweight either.
   *
   * In ALL of those cases the service passes NO `revenueReweight` to {@link decideSkillOptCycle}, so the
   * frequency-only ranking is byte-for-byte unchanged. No money / no irreversible action — a read + ranking.
   */
  revenueRewardFor?(workspaceId: string): Promise<RevenueReward | null>;
}

/** The outcome of running the cycle for one agent (the decision + the staged request id, if any). */
export interface SkillOptAgentOutcome {
  handle: string;
  skillId: string;
  result: SkillOptCycleResult;
  /** The #13 request id if a proposal was staged; null otherwise. */
  requestId: string | null;
}

/** The outcome of a full run for a workspace. */
export interface SkillOptRunResult {
  workspaceId: string;
  /** Whether the loop was enabled for this workspace (false ⇒ no agents were processed). */
  enabled: boolean;
  agents: SkillOptAgentOutcome[];
}

export class SkillOptService {
  constructor(private readonly deps: SkillOptDeps) {}

  /**
   * Run the offline cycle for every fleet agent in a workspace. Fail-closed: if the loop is disabled for
   * the workspace, returns immediately with `enabled:false` and no agents touched. For each agent it
   * harvests transcripts, mines recurring tasks, asks the replay seam for candidates, runs the pure cycle,
   * and stages any `staged` proposal in the #13 queue.
   */
  async runWorkspace(identity: SkillOptIdentity): Promise<SkillOptRunResult> {
    const caps = this.deps.caps(identity.workspaceId);
    if (!isSkillOptEnabledForWorkspace(caps, identity.workspaceId)) {
      return { workspaceId: identity.workspaceId, enabled: false, agents: [] };
    }

    // #390 (ADR-0390): build the live revenue learning signal ONCE for the workspace, gated by the
    // `attribution` flag inside the seam. Absent seam, attribution OFF, or zero attributed receipts ⇒
    // `null`/empty ⇒ NO reweight is passed below ⇒ the cycle ranks by frequency exactly as today.
    const reward = (await this.deps.revenueRewardFor?.(identity.workspaceId)) ?? null;
    const revenueReweight: RevenueReweight | undefined =
      reward && !reward.isEmpty ? { reward } : undefined;

    const outcomes: SkillOptAgentOutcome[] = [];
    for (const agent of this.deps.agents()) {
      outcomes.push(await this.runAgent(identity, caps, agent, revenueReweight));
    }
    return { workspaceId: identity.workspaceId, enabled: true, agents: outcomes };
  }

  private async runAgent(
    identity: SkillOptIdentity,
    caps: SkillOptCaps,
    agent: SkillOptAgentTarget,
    revenueReweight: RevenueReweight | undefined,
  ): Promise<SkillOptAgentOutcome> {
    const samples = await this.deps.harvest(identity.workspaceId, agent.handle);
    const clusters = mineRecurringTasks(samples, agent.handle, { minRecurrence: caps.minRecurrence });
    const candidates =
      clusters.length === 0
        ? []
        : await this.deps.replay({
            workspaceId: identity.workspaceId,
            agentHandle: agent.handle,
            skillId: agent.skillId,
            clusters,
          });
    const doc = await this.deps.loadSkillDoc(agent.skillId);

    const result = decideSkillOptCycle({
      enabled: true,
      agentHandle: agent.handle,
      skillId: agent.skillId,
      currentDocSha: doc.sha,
      samples,
      candidates,
      mine: { minRecurrence: caps.minRecurrence },
      gate: { minSampleSize: caps.minSampleSize, minImprovementRatio: caps.minImprovementRatio },
      maxAppendChars: caps.maxAppendChars,
      // #390: present only when attribution is on AND real receipts attributed (else undefined ⇒ frequency-only).
      revenueReweight,
    });

    let requestId: string | null = null;
    if (result.status === "staged") {
      const req = await this.deps.stage({
        workspaceId: identity.workspaceId,
        requesterMemberId: identity.requesterMemberId,
        proposal: result.proposal,
      });
      requestId = req.id;
    }
    return { handle: agent.handle, skillId: agent.skillId, result, requestId };
  }
}
