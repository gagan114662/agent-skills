import type { PlanProposal, PlanProposalStatus } from "../db/repositories/plan-proposals.js";
import type { SessionTurn, TurnKind } from "../db/repositories/session-turns.js";
import {
  composeExecutionTask,
  decidePlan,
  parsePlanProposal,
  validateDecisionInput,
  PlanError,
} from "./plan.js";
import { planRevert, CheckpointError, type TurnRow } from "./checkpoint.js";

/**
 * TurnController — orchestrates plan mode + checkpoints (issue #53, ADR-0030).
 *
 * It reuses the existing seams instead of touching the #25 SessionManager: plan mode is two ordinary
 * launches with a human gate between them, and a checkpoint is a #51 `commitTurn` plus a conversation
 * cursor. Every collaborator is injected, so the whole flow is unit-testable with fakes — no DB, no
 * git, no model. Channel-capability + IDOR checks are done by the route (`requireChannelCapability`);
 * this controller assumes an already-authorized caller and focuses on orchestration.
 */

export interface TurnLauncher {
  launch(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    task: string;
    harnessEnv?: Record<string, string>;
    parentMessageId?: string;
  }): Promise<{ id: string }>;
  /** Await a launched session's server-side completion (so we can read its result). */
  join(id: string): Promise<void>;
}

/** The subset of {@link GitWorkspaceService} the controller needs (null when no repo is configured). */
export interface TurnGit {
  currentHeadSha(key: string): Promise<string>;
  commitTurn(key: string, message: string): Promise<string | null>;
  resetTo(key: string, sha: string): Promise<void>;
}

export interface TurnControllerDeps {
  launcher: TurnLauncher;
  /** A finalized session's output tail — the plan-mode run's proposed-plan text is parsed from it. */
  sessionResult(sessionId: string): Promise<string | null>;
  /** The git workspace, or null → checkpoint/revert return 501 (like #51's diff/PR). */
  git: TurnGit | null;
  createProposal(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    planSessionId: string | null;
    originalTask: string;
    planText: string;
    createdByMemberId: string;
  }): Promise<PlanProposal>;
  getProposal(id: string, channelId: string): Promise<PlanProposal | undefined>;
  decideProposal(
    id: string,
    fields: {
      status: PlanProposalStatus;
      feedback: string | null;
      decidedByMemberId: string;
      executionSessionId?: string | null;
    },
  ): Promise<void>;
  nextTurnIdx(sessionId: string): Promise<number>;
  createTurn(input: {
    workspaceId: string;
    channelId: string;
    sessionId: string;
    idx: number;
    kind: TurnKind;
    headSha: string | null;
    cursorMessageId: string | null;
    planProposalId?: string | null;
    createdByMemberId?: string | null;
  }): Promise<SessionTurn>;
  listTurns(sessionId: string, opts?: { liveOnly?: boolean }): Promise<SessionTurn[]>;
  markTurnsReverted(ids: string[]): Promise<void>;
  latestMessageId(channelId: string): Promise<string | null>;
  softDeleteMessagesAfter(channelId: string, afterMessageId: string | null): Promise<number>;
}

export type Fail = { ok: false; code: 400 | 404 | 409 | 422 | 501; error: string };
export type ProposeResult = { ok: true; proposal: PlanProposal } | Fail;
export type DecideResult =
  | { ok: true; status: PlanProposalStatus; executionSessionId: string | null }
  | Fail;
export type CheckpointResult = { ok: true; turn: SessionTurn } | Fail;
export type RevertResult =
  | { ok: true; restoreSha: string; deletedMessageCount: number; discardedTurnIds: string[] }
  | Fail;

export class TurnController {
  constructor(private readonly deps: TurnControllerDeps) {}

  /**
   * Propose a plan: run the agent in plan mode (`AGENT_PLAN_MODE=1`) so it emits a plan and does NO
   * work, parse the plan from its output, and persist a `proposed` row. Launches no execution — work
   * blocks until {@link decide}.
   */
  async propose(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    originalTask: string;
    createdByMemberId: string;
  }): Promise<ProposeResult> {
    const session = await this.deps.launcher.launch({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentMemberId: input.agentMemberId,
      createdByMemberId: input.createdByMemberId,
      task: input.originalTask,
      harnessEnv: { AGENT_PLAN_MODE: "1" },
    });
    await this.deps.launcher.join(session.id);
    const output = (await this.deps.sessionResult(session.id)) ?? "";
    const planText = parsePlanProposal(output);
    if (!planText) {
      return { ok: false, code: 422, error: "plan-mode run produced no plan" };
    }
    const proposal = await this.deps.createProposal({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentMemberId: input.agentMemberId,
      planSessionId: session.id,
      originalTask: input.originalTask,
      planText,
      createdByMemberId: input.createdByMemberId,
    });
    return { ok: true, proposal };
  }

  /**
   * Decide a proposed plan. `approve` / `approve_with_feedback` launch the execution session with the
   * plan (+ feedback) composed into its task; `reject` launches nothing. A non-`proposed` plan is a
   * 409 (work blocks on exactly one decision).
   */
  async decide(input: {
    workspaceId: string;
    channelId: string;
    proposalId: string;
    decision: string;
    feedback?: string;
    decidedByMemberId: string;
  }): Promise<DecideResult> {
    const proposal = await this.deps.getProposal(input.proposalId, input.channelId);
    if (!proposal) return { ok: false, code: 404, error: "proposal not found" };
    if (proposal.status !== "proposed") {
      return { ok: false, code: 409, error: "plan has already been decided" };
    }
    let validated: { decision: ReturnType<typeof validateDecisionInput>["decision"]; feedback: string | null };
    try {
      validated = validateDecisionInput(input.decision, input.feedback);
    } catch (err) {
      if (err instanceof PlanError) return { ok: false, code: 400, error: err.message };
      throw err;
    }
    const { status, proceed } = decidePlan("proposed", validated.decision);

    let executionSessionId: string | null = null;
    if (proceed) {
      const task = composeExecutionTask(
        proposal.originalTask,
        proposal.planText,
        validated.decision,
        validated.feedback,
      );
      const exec = await this.deps.launcher.launch({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        agentMemberId: proposal.agentMemberId,
        createdByMemberId: input.decidedByMemberId,
        task,
      });
      executionSessionId = exec.id;
    }
    await this.deps.decideProposal(input.proposalId, {
      status,
      feedback: validated.feedback,
      decidedByMemberId: input.decidedByMemberId,
      executionSessionId,
    });
    return { ok: true, status, executionSessionId };
  }

  /**
   * Capture a checkpoint for a session (a turn in its ledger). The first capture (idx 0) records the
   * **baseline** — the current worktree HEAD before any work. Later captures commit the pending edits
   * (`commitTurn`) and record the new snapshot. Both record the channel's conversation cursor.
   */
  async checkpoint(input: {
    workspaceId: string;
    channelId: string;
    sessionId: string;
    createdByMemberId: string;
    planProposalId?: string | null;
  }): Promise<CheckpointResult> {
    const git = this.deps.git;
    if (!git) return { ok: false, code: 501, error: "no git workspace configured" };

    const idx = await this.deps.nextTurnIdx(input.sessionId);
    const kind: TurnKind = idx === 0 ? "baseline" : "work";
    const headSha =
      idx === 0
        ? await git.currentHeadSha(input.sessionId)
        : await git.commitTurn(input.sessionId, `turn ${idx}`);
    const cursorMessageId = await this.deps.latestMessageId(input.channelId);
    const turn = await this.deps.createTurn({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      sessionId: input.sessionId,
      idx,
      kind,
      headSha,
      cursorMessageId,
      planProposalId: input.planProposalId ?? null,
      createdByMemberId: input.createdByMemberId,
    });
    return { ok: true, turn };
  }

  /**
   * Revert to before a turn: reset the worktree to the previous checkpoint's snapshot (FILES) and
   * soft-delete the channel messages after its cursor (CONVERSATION), then mark the discarded turns
   * reverted. Restores chat and working tree together.
   */
  async revert(input: {
    channelId: string;
    sessionId: string;
    turnId: string;
  }): Promise<RevertResult> {
    const git = this.deps.git;
    if (!git) return { ok: false, code: 501, error: "no git workspace configured" };

    const turns = await this.deps.listTurns(input.sessionId, { liveOnly: true });
    const rows: TurnRow[] = turns.map((t) => ({
      id: t.id,
      idx: t.idx,
      headSha: t.headSha,
      cursorMessageId: t.cursorMessageId,
    }));
    let plan;
    try {
      plan = planRevert(rows, input.turnId);
    } catch (err) {
      if (err instanceof CheckpointError) {
        const code = err.message.includes("not found") ? 404 : 400;
        return { ok: false, code, error: err.message };
      }
      throw err;
    }
    await git.resetTo(input.sessionId, plan.restoreSha);
    const deletedMessageCount = await this.deps.softDeleteMessagesAfter(
      input.channelId,
      plan.truncateAfterMessageId,
    );
    await this.deps.markTurnsReverted(plan.discardedTurnIds);
    return {
      ok: true,
      restoreSha: plan.restoreSha,
      deletedMessageCount,
      discardedTurnIds: plan.discardedTurnIds,
    };
  }
}
