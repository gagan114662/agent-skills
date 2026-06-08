import type { ChannelPoster, SessionLogger } from "../runtime/manager.js";
import { recordAutonomyAction, recordAutonomyTick } from "../observability/metrics.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import { getTask, updateStatus, assignTask, addTaskLink } from "../db/repositories/tasks.js";
import { canTransition } from "../tasks/status.js";
import { upsertMemory } from "../db/repositories/memories.js";
import {
  getControls,
  getAutonomy,
  incrementActionsUsed,
  listActiveWorkflows,
  listActiveWorkflowWorkspaces,
  advanceWorkflowStage,
  bumpWorkflowAction,
  setWorkflowStatus,
  createApproval,
  getApproval,
  decideApproval,
  getWorkflow,
  type AgentWorkflow,
} from "../db/repositories/autonomy.js";
import { budgetExhausted, tickLimitReached } from "./guards.js";
import { decideWorkflowAction, type AutonomyAction } from "./decide.js";

/**
 * AutonomyEngine (#17, ADR-0017) — the server-owned activity loop, modelled on the #25
 * SessionManager: deps injected, side effects here, decision/guard logic pure in `./decide` and
 * `./guards`. A `tick()` is one fair pass over a workspace's `running` workflows; it applies at
 * most one action per workflow (so progression is observable and the guards are meaningful) and
 * posts as the acting agent via the #5 realtime path. The production timer (`start`) is opt-in;
 * tests drive `tick()` directly.
 */
export interface AutonomyEngineDeps {
  poster: ChannelPoster;
  logger: SessionLogger;
  /** Loop-guard ceiling override (defaults to the engine's safe default). */
  loopGuardMax?: number;
}

export interface AppliedAction {
  workflowId: string;
  action: AutonomyAction;
  reason: string;
}

export interface TickResult {
  workspaceId: string;
  killSwitch: boolean;
  actions: AppliedAction[];
}

export class AutonomyEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: AutonomyEngineDeps) {}

  /** Start the periodic loop over every workspace with active work. No-op if interval ≤ 0. */
  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tickAll(), intervalMs);
    this.timer.unref?.();
  }

  /** Stop the periodic loop (idempotent) — called on server shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One pass over every workspace that currently has a running workflow. */
  async tickAll(): Promise<void> {
    const workspaceIds = await listActiveWorkflowWorkspaces();
    for (const workspaceId of workspaceIds) {
      try {
        await this.tick(workspaceId);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "autonomy tickAll: workspace tick failed");
      }
    }
  }

  /**
   * One fair pass over a workspace's `running` workflows. The kill switch is checked first and
   * halts the whole tick immediately. Each workflow gets at most one applied action; per-agent
   * rate limits and per-agent cost budgets are enforced as we go.
   */
  async tick(workspaceId: string): Promise<TickResult> {
    recordAutonomyTick();
    const log = this.deps.logger.child({ workspaceId, component: "autonomy" });

    const controls = await getControls(workspaceId);
    if (controls.killSwitch) {
      log.warn({}, "autonomy tick skipped: kill switch engaged");
      recordAutonomyAction("noop:kill_switch");
      return { workspaceId, killSwitch: true, actions: [] };
    }

    const workflows = await listActiveWorkflows(workspaceId);
    const perAgentThisTick = new Map<string, number>();
    const actions: AppliedAction[] = [];

    for (const wf of workflows) {
      const stage = wf.stages[wf.currentStage];
      if (!stage) {
        recordAutonomyAction("noop:no_stage");
        continue;
      }
      const agentMemberId = stage.agentMemberId;

      const autonomy = await getAutonomy(workspaceId, agentMemberId);
      if (!autonomy || !autonomy.enabled) {
        recordAutonomyAction("noop:agent_disabled");
        actions.push({ workflowId: wf.id, action: "noop", reason: "agent_disabled" });
        continue;
      }

      const usedThisTick = perAgentThisTick.get(agentMemberId) ?? 0;
      if (tickLimitReached(usedThisTick, autonomy.maxActionsPerTick)) {
        recordAutonomyAction("noop:rate_limited");
        actions.push({ workflowId: wf.id, action: "noop", reason: "rate_limited" });
        continue;
      }

      const task = await getTask(wf.taskId);
      if (!task) {
        recordAutonomyAction("noop:task_missing");
        continue;
      }

      const decision = decideWorkflowAction({
        task: { status: task.status },
        workflow: {
          status: wf.status,
          currentStage: wf.currentStage,
          stageCount: wf.stages.length,
          actionCount: wf.actionCount,
        },
        killSwitch: false, // already gated above
        budgetExhausted: budgetExhausted(autonomy.actionsUsed, autonomy.actionBudget),
        loopGuardMax: this.deps.loopGuardMax,
      });

      if (decision.action === "noop") {
        recordAutonomyAction(`noop:${decision.reason}`);
        actions.push({ workflowId: wf.id, action: "noop", reason: decision.reason });
        continue;
      }

      await this.apply(wf, task.id, task.title, agentMemberId, decision.action, log);
      await incrementActionsUsed(autonomy.id);
      perAgentThisTick.set(agentMemberId, usedThisTick + 1);
      recordAutonomyAction(decision.action);
      actions.push({ workflowId: wf.id, action: decision.action, reason: decision.reason });
    }

    log.info({ count: actions.filter((a) => a.action !== "noop").length }, "autonomy tick complete");
    return { workspaceId, killSwitch: false, actions };
  }

  /** Apply a single decided action: the DB writes + the narrated channel message. */
  private async apply(
    wf: AgentWorkflow,
    taskId: string,
    taskTitle: string,
    agentMemberId: string,
    action: Exclude<AutonomyAction, "noop">,
    log: SessionLogger,
  ): Promise<void> {
    switch (action) {
      case "start": {
        await updateStatus(taskId, "in_progress", agentMemberId);
        await bumpWorkflowAction(wf.id);
        await this.post(wf, agentMemberId, `🤖 picked up task “${taskTitle}” — starting autonomously.`, log);
        return;
      }
      case "handoff": {
        const next = wf.stages[wf.currentStage + 1]!;
        const fromRole = wf.stages[wf.currentStage]!.role;
        const note =
          `Handoff for “${taskTitle}”: stage ${wf.currentStage + 1}/${wf.stages.length} ` +
          `(${fromRole}) complete; continuing as ${next.role}.`;
        // A2A continuity rides in #16 shared memory, linked to the #14 task.
        const mem = await upsertMemory({
          workspaceId: wf.workspaceId,
          type: "handoff",
          content: { text: note, workflowId: wf.id, fromStage: wf.currentStage },
          entity: taskTitle,
          dedupeKey: `handoff:${wf.id}:${wf.currentStage}`,
          sourceType: "task",
          sourceId: taskId,
          createdByMemberId: agentMemberId,
        });
        await addTaskLink({
          workspaceId: wf.workspaceId,
          taskId,
          targetType: "memory",
          targetId: mem.id,
          createdByMemberId: agentMemberId,
        });
        await assignTask(taskId, next.agentMemberId, agentMemberId);
        await advanceWorkflowStage(wf.id, wf.currentStage + 1);
        const nextMember = await getWorkspaceMember(next.agentMemberId, wf.workspaceId);
        await this.post(
          wf,
          agentMemberId,
          `🤝 handoff → ${nextMember?.displayName ?? "next agent"} (${next.role}); ` +
            `continuity saved to shared memory ${mem.id}.`,
          log,
        );
        return;
      }
      case "request_approval": {
        await createApproval({
          workspaceId: wf.workspaceId,
          workflowId: wf.id,
          taskId,
          requestedByMemberId: agentMemberId,
          action: "complete_workflow",
        });
        await setWorkflowStatus(wf.id, "awaiting_approval");
        await bumpWorkflowAction(wf.id);
        await this.post(
          wf,
          agentMemberId,
          `⛔ awaiting human approval to complete “${taskTitle}”.`,
          log,
        );
        return;
      }
    }
  }

  /**
   * Approve a pending gate: mark it approved, drive the task to `done`, complete the workflow, and
   * narrate it. Idempotent — a non-pending approval is a no-op. The caller has already asserted the
   * approver is a human in this workspace (an agent can never approve its own gate).
   */
  async approve(
    workspaceId: string,
    approvalId: string,
    humanMemberId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const approval = await getApproval(approvalId, workspaceId);
    if (!approval) return { ok: false, reason: "not_found" };
    const decided = await decideApproval(approvalId, {
      status: "approved",
      decidedByMemberId: humanMemberId,
    });
    if (!decided) return { ok: false, reason: "not_pending" };

    const task = await getTask(approval.taskId);
    if (task && task.status !== "done" && canTransition(task.status, "done")) {
      await updateStatus(approval.taskId, "done", humanMemberId);
    }
    if (approval.workflowId) {
      await setWorkflowStatus(approval.workflowId, "completed");
      const wf = await getWorkflow(approval.workflowId, workspaceId);
      if (wf) {
        await this.post(wf, humanMemberId, `✅ approved & completed by a human reviewer.`, this.deps.logger);
      }
    }
    return { ok: true };
  }

  /** Reject a pending gate: mark it rejected, cancel the workflow, narrate it. Idempotent. */
  async reject(
    workspaceId: string,
    approvalId: string,
    humanMemberId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const approval = await getApproval(approvalId, workspaceId);
    if (!approval) return { ok: false, reason: "not_found" };
    const decided = await decideApproval(approvalId, {
      status: "rejected",
      decidedByMemberId: humanMemberId,
    });
    if (!decided) return { ok: false, reason: "not_pending" };

    if (approval.workflowId) {
      await setWorkflowStatus(approval.workflowId, "canceled");
      const wf = await getWorkflow(approval.workflowId, workspaceId);
      if (wf) {
        await this.post(wf, humanMemberId, `❌ rejected by a human reviewer; workflow canceled.`, this.deps.logger);
      }
    }
    return { ok: true };
  }

  /** Post into the workflow's channel; a delivery error never fails the tick. */
  private async post(
    wf: AgentWorkflow,
    authorMemberId: string,
    body: string,
    log: SessionLogger,
  ): Promise<void> {
    try {
      await this.deps.poster.post({
        workspaceId: wf.workspaceId,
        channelId: wf.channelId,
        agentMemberId: authorMemberId,
        body,
      });
    } catch (err) {
      log.error({ err, workflowId: wf.id }, "autonomy channel post failed");
    }
  }
}
