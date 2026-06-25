import type { ChannelPoster, SessionLogger } from "../runtime/manager.js";
import type { SessionStatus } from "../db/repositories/agent-sessions.js";
import {
  recordAutonomyAction,
  recordAutonomyTick,
  recordLoopTickFailure,
} from "../observability/metrics.js";
import {
  recordLoopWorkspaceFailure,
  type LoopFailureRecorder,
} from "../observability/loop-failures.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import { getTask, updateStatus } from "../db/repositories/tasks.js";
import { canTransition } from "../tasks/status.js";
import { upsertMemory } from "../db/repositories/memories.js";
import {
  getControls,
  getAutonomy,
  tryReserveActionsUsed,
  refundActionsUsed,
  listActiveWorkflows,
  listActiveWorkflowWorkspaces,
  bumpWorkflowAction,
  setWorkflowStatus,
  handoffWorkflowStage,
  markWorkflowAwaitingApproval,
  completeWorkflowWithTask,
  createApproval,
  findWorkflowApproval,
  getApproval,
  decideApproval,
  getWorkflow,
  type AgentWorkflow,
} from "../db/repositories/autonomy.js";
import { budgetExhausted, tickLimitReached } from "./guards.js";
import { decideWorkflowAction, type AutonomyAction } from "./decide.js";
import { evaluatePolicy, AUTONOMY_COMPLETE_ACTION, type PolicyRule } from "../approvals/policy.js";

/**
 * AutonomyEngine (#17, ADR-0017; real-session execution #84, ADR-0042) — the server-owned activity
 * loop, modelled on the #25 SessionManager: deps injected, side effects here, decision/guard logic
 * pure in `./decide` and `./guards`. A `tick()` is one fair pass over a workspace's `running`
 * workflows; it applies at most one action per workflow (so progression is observable and the
 * guards are meaningful) and posts as the acting agent via the #5 realtime path. The production
 * timer (`start`) is opt-in; tests drive `tick()` directly.
 *
 * When a {@link AutonomyLauncher} is wired, a `start`/`handoff` action **launches a real agent
 * session** (the #25 SessionManager) for the stage — past the same kill-switch/budget/rate-limit/
 * loop guards (admission), with at most one live session per workflow at a time. The session's
 * server-side completion feeds back into task status (done on success, blocked on failure) so the
 * loop closes. Without a launcher the engine keeps its prior narration-only behaviour.
 */

/**
 * The session-launch surface the engine drives. The #25 {@link SessionManager} satisfies it
 * structurally: `launch` returns immediately (the run continues server-side), `join` awaits that
 * run's completion, and `status` reads the terminal status so it can feed back into the task. Tests
 * inject a fake to assert launch-on-start + guard-blocks without a runtime or a DB.
 */
export interface AutonomyLauncher {
  launch(input: {
    workspaceId: string;
    channelId: string;
    taskId?: string;
    agentMemberId: string;
    createdByMemberId: string;
    task: string;
    harnessEnv?: Record<string, string>;
  }): Promise<{ id: string }>;
  join(id: string): Promise<void>;
  status(id: string): Promise<SessionStatus>;
}

/** A workspace policy rule plus its id — `PolicyRule`-compatible, carrying the audit anchor (#84). */
export interface CompletionPolicyRule extends PolicyRule {
  id: string;
}

export interface AutonomyEngineDeps {
  poster: ChannelPoster;
  logger: SessionLogger;
  /**
   * Optional real-agent launcher (#84). When present, `start`/`handoff` launch a real agent session
   * for the stage; when absent the engine narrates the action only (its pre-#84 behaviour).
   */
  launcher?: AutonomyLauncher;
  /**
   * Optional auto-approve policy source for autonomous completion (#84 follow-up, ADR-0042). When a
   * workspace's `autonomy.complete` policy rule auto-approves, a completed final stage closes straight
   * to `done` instead of parking at the human gate. When absent — or when no rule matches — the human
   * approval gate (#13/#20) holds, exactly as before. Defaults to the #13 `approval_policies` store in
   * production; tests inject a fake.
   */
  completionPolicies?: (workspaceId: string) => Promise<CompletionPolicyRule[]>;
  /** Loop-guard ceiling override (defaults to the engine's safe default). */
  loopGuardMax?: number;
  /**
   * Optional maintenance-pause check (#99, ADR-0099). When it resolves true, `tickAll()` skips the
   * whole pass BEFORE any DB call — the autonomy loop pauses on the same Redis flag the HTTP
   * write-gate reads. Absent ⇒ never paused (unchanged behaviour).
   */
  maintenancePaused?: () => Promise<boolean>;
  /** Workspace lister override (defaults to the repository fn); tests inject a spy. */
  listActiveWorkspaces?: () => Promise<string[]>;
  /** Optional #117 flywheel recorder for deduped per-workspace loop infrastructure failures (#887). */
  failureRecorder?: LoopFailureRecorder;
}

/** Compose the task/prompt handed to the harness for a stage (data, never argv). */
function composeStageTask(input: {
  workspaceId: string;
  taskId: string;
  taskTitle: string;
  role: string;
  handoffContext?: string;
}): string {
  const contextPath = `/workspaces/${input.workspaceId}/tasks/${input.taskId}/context`;
  const handoff =
    input.handoffContext && input.handoffContext.trim().length > 0
      ? `\n\nPrior-stage handoff context:\n${input.handoffContext.trim()}`
      : "";
  return (
    `You are the ${input.role} on an autonomous workflow. Work the task to completion: ${input.taskTitle}\n\n` +
    `Before starting new work, read the prior-stage handoff context for this task from ${contextPath} ` +
    `or use AGENT_TASK_ID=${input.taskId} to fetch the same linked context. Incorporate any handoff memory into your plan and output.` +
    handoff
  );
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
  /**
   * Workflows with a live agent session this process is driving → its completion tracker (#84). A
   * workflow is admitted at most one session at a time: while one is in flight the tick skips it, so
   * the engine never double-acts (e.g. asks for approval) on top of a still-running agent.
   */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly deps: AutonomyEngineDeps) {}

  private async getOrCreateCompletionApproval(input: {
    wf: AgentWorkflow;
    taskId: string;
    agentMemberId: string;
  }) {
    const action = "complete_workflow";
    const existing = await findWorkflowApproval({
      workspaceId: input.wf.workspaceId,
      workflowId: input.wf.id,
      taskId: input.taskId,
      action,
    });
    if (existing) return existing;
    return createApproval({
      workspaceId: input.wf.workspaceId,
      workflowId: input.wf.id,
      taskId: input.taskId,
      requestedByMemberId: input.agentMemberId,
      action,
    });
  }

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
    try {
      // #99: maintenance pauses the loop on the same Redis flag the HTTP write-gate reads. Checked
      // BEFORE any DB call so a maintenance window stops all autonomy work immediately.
      if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) {
        this.deps.logger.warn({}, "autonomy tickAll skipped: maintenance mode active");
        return;
      }
      const listWorkspaces = this.deps.listActiveWorkspaces ?? listActiveWorkflowWorkspaces;
      const workspaceIds = await listWorkspaces();
      for (const workspaceId of workspaceIds) {
        try {
          await this.tick(workspaceId);
        } catch (err) {
          await recordLoopWorkspaceFailure({
            recorder: this.deps.failureRecorder,
            loop: "autonomy",
            workspaceId,
            err,
          });
          this.deps.logger.error({ err, workspaceId }, "autonomy tickAll: workspace tick failed");
        }
      }
    } catch (err) {
      recordLoopTickFailure("autonomy");
      this.deps.logger.error({ err }, "autonomy tickAll failed");
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

      // Admission (#84): a workflow with a live session is busy — never act on top of it.
      if (this.inflight.has(wf.id)) {
        recordAutonomyAction("noop:session_running");
        actions.push({ workflowId: wf.id, action: "noop", reason: "session_running" });
        continue;
      }

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

      const reserved = await tryReserveActionsUsed(autonomy.id);
      if (!reserved) {
        recordAutonomyAction("noop:budget_exhausted");
        actions.push({ workflowId: wf.id, action: "noop", reason: "budget_exhausted" });
        continue;
      }
      try {
        await this.apply(wf, task.id, task.title, agentMemberId, decision.action, log);
      } catch (err) {
        await refundActionsUsed(autonomy.id);
        throw err;
      }
      perAgentThisTick.set(agentMemberId, usedThisTick + 1);
      recordAutonomyAction(decision.action);
      actions.push({ workflowId: wf.id, action: decision.action, reason: decision.reason });
    }

    log.info(
      { count: actions.filter((a) => a.action !== "noop").length },
      "autonomy tick complete",
    );
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
        await this.launchStage(wf, taskId, taskTitle, wf.currentStage, agentMemberId, log);
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
        const handoff = await handoffWorkflowStage({
          workflowId: wf.id,
          expectedCurrentStage: wf.currentStage,
          toStage: wf.currentStage + 1,
          taskId,
          workspaceId: wf.workspaceId,
          nextAgentMemberId: next.agentMemberId,
          actorMemberId: agentMemberId,
          memoryId: mem.id,
        });
        if (!handoff.advanced) return;
        const nextMember = await getWorkspaceMember(next.agentMemberId, wf.workspaceId);
        await this.post(
          wf,
          agentMemberId,
          `🤝 handoff → ${nextMember?.displayName ?? "next agent"} (${next.role}); ` +
            `continuity saved to shared memory ${mem.id}.`,
          log,
        );
        // The next stage's agent now actually does the work (#84): launch its session as that member.
        await this.launchStage(
          wf,
          taskId,
          taskTitle,
          wf.currentStage + 1,
          next.agentMemberId,
          log,
          note,
        );
        return;
      }
      case "request_approval": {
        await this.getOrCreateCompletionApproval({ wf, taskId, agentMemberId });
        await markWorkflowAwaitingApproval(wf.id);
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
   * Launch the real agent session for a stage (#84) and register its completion tracker. Without a
   * launcher this narrates the action only (pre-#84 behaviour), so the existing pooling/autonomy
   * tests — which wire no launcher — are unchanged. The session runs as the stage's agent member, in
   * the workflow's channel, with the task composed as the harness prompt (data, never argv).
   */
  private async launchStage(
    wf: AgentWorkflow,
    taskId: string,
    taskTitle: string,
    stageIndex: number,
    agentMemberId: string,
    log: SessionLogger,
    handoffContext?: string,
  ): Promise<void> {
    const role = wf.stages[stageIndex]?.role ?? "agent";
    if (!this.deps.launcher) {
      await this.post(
        wf,
        agentMemberId,
        `🤖 picked up task “${taskTitle}” — starting autonomously.`,
        log,
      );
      return;
    }
    let session: { id: string };
    try {
      session = await this.deps.launcher.launch({
        workspaceId: wf.workspaceId,
        channelId: wf.channelId,
        taskId,
        agentMemberId,
        createdByMemberId: agentMemberId,
        task: composeStageTask({
          workspaceId: wf.workspaceId,
          taskId,
          taskTitle,
          role,
          handoffContext,
        }),
        harnessEnv: { AGENT_AUTONOMY: "1", AGENT_ROLE: role, AGENT_TASK_ID: taskId },
      });
    } catch (err) {
      // A launch that never starts must not silently strand the task — surface it as blocked.
      log.error({ err, workflowId: wf.id }, "autonomy session launch failed");
      if (canTransition("in_progress", "blocked")) {
        await updateStatus(taskId, "blocked", agentMemberId);
      }
      await this.post(
        wf,
        agentMemberId,
        `⚠️ could not launch an agent session for “${taskTitle}” — task blocked for review.`,
        log,
      );
      return;
    }
    await this.post(
      wf,
      agentMemberId,
      `🤖 picked up task “${taskTitle}” — launched agent session ${session.id} ` +
        `(stage ${stageIndex + 1}/${wf.stages.length}, ${role}).`,
      log,
    );
    this.trackSession(wf, taskId, taskTitle, stageIndex, agentMemberId, session.id, log);
  }

  /** Drive a launched session to completion off the tick, then feed its outcome back to the task. */
  private trackSession(
    wf: AgentWorkflow,
    taskId: string,
    taskTitle: string,
    stageIndex: number,
    agentMemberId: string,
    sessionId: string,
    log: SessionLogger,
  ): void {
    let settled = false;
    const run = (async (): Promise<void> => {
      try {
        await this.deps.launcher!.join(sessionId);
        const status = await this.deps.launcher!.status(sessionId);
        await this.onSessionSettled(
          wf,
          taskId,
          taskTitle,
          stageIndex,
          agentMemberId,
          sessionId,
          status,
          log,
        );
        settled = true;
      } catch (err) {
        log.error({ err, sessionId, workflowId: wf.id }, "autonomy session tracking failed");
        throw err;
      }
    })();
    this.inflight.set(wf.id, run);
    void run
      .finally(() => {
        if (settled && this.inflight.get(wf.id) === run) this.inflight.delete(wf.id);
      })
      .catch(() => {});
  }

  /**
   * Decide whether a completed final stage may auto-approve, and which rule authorised it (#84
   * follow-up, ADR-0042). With no policy source wired, or no matching auto-approve rule, the human
   * gate holds (`autoApprove: false`) — `autonomy.complete` is sensitive by default, so a workspace
   * must opt in explicitly. Reuses the #13 pure `evaluatePolicy`, scoped to the workflow's workspace
   * (no cross-tenant leakage — the rules are fetched per workspace).
   */
  private async completionDecision(
    workspaceId: string,
  ): Promise<{ autoApprove: boolean; ruleId: string | null }> {
    if (!this.deps.completionPolicies) return { autoApprove: false, ruleId: null };
    const rules = await this.deps.completionPolicies(workspaceId);
    const decision = evaluatePolicy({ actionType: AUTONOMY_COMPLETE_ACTION }, rules);
    if (decision.requiresApproval) return { autoApprove: false, ruleId: null };
    const rule = rules.find((r) => r.actionType === AUTONOMY_COMPLETE_ACTION);
    return { autoApprove: true, ruleId: rule?.id ?? null };
  }

  /**
   * Close the loop on a finished session (#84). Success of the final stage drives the task to `done`
   * and completes the workflow; success of an earlier stage clears admission so the next tick hands
   * off to the next stage. Any non-`completed` terminal state blocks the task for human review. All
   * writes go through the same status guards as the rest of the engine.
   */
  private async onSessionSettled(
    wf: AgentWorkflow,
    taskId: string,
    taskTitle: string,
    stageIndex: number,
    agentMemberId: string,
    sessionId: string,
    status: SessionStatus,
    log: SessionLogger,
  ): Promise<void> {
    const task = await getTask(taskId);
    if (!task) return;

    if (status === "completed") {
      const isFinalStage = stageIndex >= wf.stages.length - 1;
      if (isFinalStage) {
        // The agent did the work; acceptance closes the loop. A gate record is always created (the
        // audit anchor). By default a human closes it — success never drives `done` directly. An
        // explicit workspace `autonomy.complete` auto-approve policy (#84 follow-up, ADR-0042) lets a
        // trusted workflow skip the human: the gate is decided BY POLICY (recording which rule fired)
        // and the task goes straight to `done` + the workflow to `completed`. With no rule the gate
        // holds exactly as before.
        const approval = await this.getOrCreateCompletionApproval({ wf, taskId, agentMemberId });
        const policy = await this.completionDecision(wf.workspaceId);
        if (policy.autoApprove) {
          await decideApproval(approval.id, {
            status: "approved",
            decidedByMemberId: null,
            decisionSource: "policy",
            policyRuleId: policy.ruleId,
          });
          await completeWorkflowWithTask({
            workflowId: wf.id,
            taskId,
            actorMemberId: agentMemberId,
            completeTask: task.status === "done" || canTransition(task.status, "done"),
          });
          await this.post(
            wf,
            agentMemberId,
            `✅ agent session ${sessionId} completed “${taskTitle}” — auto-approved to done by ` +
              `policy rule ${policy.ruleId} (autonomy.complete); no human gate.`,
            log,
          );
        } else {
          await markWorkflowAwaitingApproval(wf.id);
          await this.post(
            wf,
            agentMemberId,
            `✅ agent session ${sessionId} completed “${taskTitle}” — awaiting human approval to complete.`,
            log,
          );
        }
      } else {
        await this.post(
          wf,
          agentMemberId,
          `✅ agent session ${sessionId} finished stage ${stageIndex + 1}/${wf.stages.length}; ` +
            `handing off next tick.`,
          log,
        );
      }
      return;
    }

    // failed / timeout / idle_reaped / canceled → the work did not land; block for review.
    if (task.status !== "blocked" && canTransition(task.status, "blocked")) {
      await updateStatus(taskId, "blocked", agentMemberId);
    }
    await this.post(
      wf,
      agentMemberId,
      `⚠️ agent session ${sessionId} ended ${status} — task “${taskTitle}” blocked for review.`,
      log,
    );
  }

  /** Await every in-flight session tracker (test/shutdown helper; never rejects). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight.values()]);
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
    if (approval.workflowId) {
      await completeWorkflowWithTask({
        workflowId: approval.workflowId,
        taskId: approval.taskId,
        actorMemberId: humanMemberId,
        completeTask: !!task && task.status !== "done" && canTransition(task.status, "done"),
      });
    } else if (task && task.status !== "done" && canTransition(task.status, "done")) {
        await updateStatus(approval.taskId, "done", humanMemberId);
    }
    if (approval.workflowId) {
      const wf = await getWorkflow(approval.workflowId, workspaceId);
      if (wf) {
        await this.post(
          wf,
          humanMemberId,
          `✅ approved & completed by a human reviewer.`,
          this.deps.logger,
        );
      }
    }
    return { ok: true };
  }

  /**
   * Reject a pending gate: mark it rejected, drive the task to `blocked` (the work was not accepted —
   * it needs human attention, the mirror of `approve()` driving `done`), cancel the workflow, and
   * narrate it. Idempotent — a non-pending approval is a no-op.
   */
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

    const task = await getTask(approval.taskId);
    if (task && task.status !== "blocked" && canTransition(task.status, "blocked")) {
      await updateStatus(approval.taskId, "blocked", humanMemberId);
    }
    if (approval.workflowId) {
      await setWorkflowStatus(approval.workflowId, "canceled");
      const wf = await getWorkflow(approval.workflowId, workspaceId);
      if (wf) {
        await this.post(
          wf,
          humanMemberId,
          `❌ rejected by a human reviewer; workflow canceled and task blocked for review.`,
          this.deps.logger,
        );
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
