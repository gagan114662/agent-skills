import type { SessionLogger } from "../runtime/manager.js";
import type { FailureEvent } from "../flywheel/types.js";
import { computeNextRun, isDue } from "../automations/schedule.js";
import { renderTemplate } from "../automations/templates.js";
import { evaluateConditions } from "./conditions.js";
import { decideWorkflowRun } from "./decide.js";
import { resolveWorkflowCaps, type WorkflowCaps } from "./caps.js";
import type {
  WorkflowAction,
  WorkflowActionResult,
  WorkflowFacts,
  WorkflowRecord,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunTrigger,
  WorkflowTriggerKind,
} from "./types.js";

/**
 * WorkflowEngine (#152, ADR-0152) — the generalization of the #147 AutomationEngine into a
 * trigger → conditions → actions runner. It mirrors the proven supervisor shape: an opt-in
 * `start(intervalMs)` timer (default 0), a `tickAll()` that checks the #99 maintenance flag before any
 * DB call, a per-workspace `tickWorkspace` gated on the config `enabled` flag then the #17 kill switch,
 * a **pure decision core** (`conditions.ts` + `decide.ts`), and a definition table + run-ledger pair.
 *
 * Every action reuses an EXISTING gated path, so the feature adds zero new egress:
 *  - `agent_task`   → the SAME #96/#71-gated, draft-only #123 launcher automations use.
 *  - `draft_send`   → a PENDING #13 approval (never a direct send).
 *  - `notify_owner` → an in-app notification.
 *
 * A `failed` run is fed to the #117 flywheel (the optional `flywheelRecord` seam), so a broken workflow
 * fingerprints + dedupes into an issue like any other failure.
 */

// ---- store seam ---------------------------------------------------------------------------------

export interface WorkflowStore {
  create(input: {
    workspaceId: string;
    name: string;
    triggerKind: WorkflowRecord["triggerKind"];
    trigger: WorkflowRecord["trigger"];
    conditions: WorkflowRecord["conditions"];
    actions: WorkflowRecord["actions"];
    webhookTokenHash: string | null;
    enabled: boolean;
    createdByMemberId: string;
    nextRunAt: Date | null;
  }): Promise<WorkflowRecord>;
  get(workspaceId: string, id: string): Promise<WorkflowRecord | null>;
  list(workspaceId: string): Promise<WorkflowRecord[]>;
  countForWorkspace(workspaceId: string): Promise<number>;
  setEnabled(workspaceId: string, id: string, enabled: boolean, nextRunAt: Date | null): Promise<WorkflowRecord | null>;
  remove(workspaceId: string, id: string): Promise<boolean>;
  /** Enabled schedule workflows whose cursor is due (`enabled AND next_run_at <= now`). */
  listDue(workspaceId: string, now: Date): Promise<WorkflowRecord[]>;
  /** Enabled workflows of a given event trigger kind (catalog_change / channel_event). */
  listByTrigger(workspaceId: string, triggerKind: WorkflowTriggerKind): Promise<WorkflowRecord[]>;
  /** Advance the scheduler cursor after a due workflow is processed. */
  markFired(input: { id: string; lastFiredAt: Date; nextRunAt: Date | null }): Promise<void>;
  /** Append a run-ledger row. */
  recordRun(input: {
    workspaceId: string;
    workflowId: string;
    trigger: WorkflowRunTrigger;
    status: WorkflowRunStatus;
    reason: string;
    results: WorkflowActionResult[];
  }): Promise<WorkflowRun>;
  /** A workspace's run ledger, newest first (the console + insights source). */
  listRuns(workspaceId: string, limit?: number): Promise<WorkflowRun[]>;
  /** Count firings (`fired`) for a workspace since `since` (the per-tenant rate-limit input). */
  countRunsInWindow(workspaceId: string, since: Date): Promise<number>;
  /** Resolve a webhook workflow by its token hash (cross-workspace — carries its own workspaceId). */
  findByWebhookHash(hash: string): Promise<WorkflowRecord | null>;
  /** Workspaces with at least one enabled schedule workflow (the tick work-list). */
  activeWorkspaces(): Promise<string[]>;
}

// ---- action seams (each reuses an existing gated path) ------------------------------------------

/** The #123 venture-gated subagent launcher (the agent_task action) — same seam automations bind. */
export interface WorkflowLauncher {
  launch(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    task: string;
    harnessEnv?: Record<string, string>;
  }): Promise<{ id: string }>;
}

/** The #13 gate (the draft_send action): a draft becomes a PENDING approval — never a direct send. */
export interface WorkflowDraftSendGate {
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    sendKind: string;
    summary: string;
    target?: string;
    amountCents?: number;
  }): Promise<{ approvalRequestId: string }>;
}

/** The notification seam (the notify_owner action). */
export interface WorkflowNotifier {
  notifyOwner(input: { workspaceId: string; message: string; createdByMemberId: string }): Promise<{ id: string }>;
}

export interface WorkflowEngineDeps {
  store: WorkflowStore;
  launcher: WorkflowLauncher;
  draftSendGate: WorkflowDraftSendGate;
  notifier: WorkflowNotifier;
  /** Resolve the #123 department persona's agent member id from its handle, or null if not seeded. */
  resolveAgentMember: (workspaceId: string, handle: string) => Promise<{ agentMemberId: string } | null>;
  /** Resolve the facts bag a workflow's conditions evaluate against (catalog rollups + metrics). */
  resolveFacts: (workflow: WorkflowRecord) => Promise<WorkflowFacts>;
  /** Resolve the per-workspace workflows caps (config; default OFF). */
  caps: (workspaceId: string) => WorkflowCaps;
  /** The #17 kill switch for a workspace (halts its tick). */
  killSwitch: (workspaceId: string) => Promise<boolean>;
  /** Optional #117 flywheel feed: a `failed` run is recorded as a failure event. */
  flywheelRecord?: (event: FailureEvent) => Promise<unknown>;
  /** Optional maintenance-pause check (#99) — when true, `tickAll()` skips BEFORE any DB call. */
  maintenancePaused?: () => Promise<boolean>;
  logger: SessionLogger;
  /** Clock seam — defaults to `new Date()`; tests inject a fixed clock. */
  now?: () => Date;
}

export class WorkflowEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: WorkflowEngineDeps) {}

  private clock(): Date {
    return this.deps.now?.() ?? new Date();
  }

  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tickAll(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One pass over every workspace with enabled schedule workflows. */
  async tickAll(): Promise<void> {
    if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) {
      this.deps.logger.warn({}, "workflows tickAll skipped: maintenance mode active");
      return;
    }
    const now = this.clock();
    const workspaces = await this.deps.store.activeWorkspaces();
    for (const workspaceId of workspaces) {
      try {
        await this.tickWorkspace(workspaceId, now);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "workflows tickAll: workspace tick failed");
      }
    }
  }

  /** One pass over a single workspace: fire each due schedule workflow, advancing its cursor. */
  async tickWorkspace(
    workspaceId: string,
    now: Date,
  ): Promise<{ workspaceId: string; runs: WorkflowRun[]; skipped?: "disabled" | "kill_switch" }> {
    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return { workspaceId, runs: [], skipped: "disabled" };
    if (await this.deps.killSwitch(workspaceId)) {
      this.deps.logger.warn({ workspaceId }, "workflows tick skipped: kill switch engaged");
      return { workspaceId, runs: [], skipped: "kill_switch" };
    }

    const due = await this.deps.store.listDue(workspaceId, now);
    const runs: WorkflowRun[] = [];
    for (const workflow of due) {
      const run = await this.runWorkflow(workflow, "schedule", now, { capsEnabled: true, killSwitch: false });
      runs.push(run);
      // Advance the cursor whether we fired or skipped, so the same slot never re-fires.
      const nextRunAt = workflow.trigger.schedule ? computeNextRun(workflow.trigger.schedule, now) : null;
      await this.deps.store.markFired({ id: workflow.id, lastFiredAt: now, nextRunAt });
    }
    this.deps.logger.info({ workspaceId, runs: runs.length }, "workflows tick complete");
    return { workspaceId, runs };
  }

  /**
   * Fire all enabled workflows of an event trigger kind for a workspace (the catalog_change /
   * channel_event seam). Best-effort: a caller (e.g. the catalog route after a mutation) invokes this
   * and never awaits the agent work — gating + recording are identical to a scheduled tick.
   */
  async fireEvent(
    workspaceId: string,
    triggerKind: Extract<WorkflowTriggerKind, "catalog_change" | "channel_event">,
    context: { catalogKind?: string; channelId?: string } = {},
  ): Promise<WorkflowRun[]> {
    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return [];
    const candidates = await this.deps.store.listByTrigger(workspaceId, triggerKind);
    const now = this.clock();
    const runs: WorkflowRun[] = [];
    for (const workflow of candidates) {
      // A catalog_change/channel_event trigger may narrow to a specific kind/channel.
      if (triggerKind === "catalog_change" && workflow.trigger.catalogKind && context.catalogKind) {
        if (workflow.trigger.catalogKind !== context.catalogKind) continue;
      }
      if (triggerKind === "channel_event" && workflow.trigger.channelId && context.channelId) {
        if (workflow.trigger.channelId !== context.channelId) continue;
      }
      try {
        runs.push(await this.runWorkflow(workflow, triggerKind, now));
      } catch (err) {
        this.deps.logger.error({ err, workspaceId, workflowId: workflow.id }, "workflows fireEvent failed");
      }
    }
    return runs;
  }

  /**
   * Evaluate + (maybe) fire one workflow, recording a durable run. Shared by the tick, manual run-now,
   * the webhook route, and `fireEvent`. Resolves every async fact, evaluates the conditions, then the
   * pure `decideWorkflowRun` makes the single call; a `run` executes each action in order.
   */
  async runWorkflow(
    workflow: WorkflowRecord,
    trigger: WorkflowRunTrigger,
    now: Date = this.clock(),
    gates?: { capsEnabled: boolean; killSwitch: boolean },
  ): Promise<WorkflowRun> {
    const caps = this.deps.caps(workflow.workspaceId);
    const capsEnabled = gates?.capsEnabled ?? caps.enabled;
    const killSwitch = gates?.killSwitch ?? (await this.deps.killSwitch(workflow.workspaceId));
    const since = new Date(now.getTime() - caps.windowMinutes * 60_000);
    const runsInWindow = await this.deps.store.countRunsInWindow(workflow.workspaceId, since);
    const due = trigger === "schedule" ? isDue(workflow.nextRunAt, now) : true;

    // Conditions are pure over a facts bag the engine resolves once. Resolve only when it could matter
    // (skipping a disabled/not-due workflow shouldn't pay for fact resolution).
    let conditionsMet = true;
    let conditionReason = "";
    const wouldEvaluate = capsEnabled && workflow.enabled && !killSwitch && due;
    if (wouldEvaluate && workflow.conditions.length > 0) {
      const facts = await this.deps.resolveFacts(workflow);
      const evaluation = evaluateConditions(workflow.conditions, facts);
      conditionsMet = evaluation.met;
      if (!evaluation.met) conditionReason = `condition_${evaluation.failedIndex}`;
    }

    const decision = decideWorkflowRun({
      capsEnabled,
      workflowEnabled: workflow.enabled,
      killSwitch,
      due,
      conditionsMet,
      runsInWindow,
      maxRunsPerWindow: caps.maxRunsPerWindow,
    });

    if (decision.action === "skip") {
      const reason =
        decision.reason === "conditions_unmet" && conditionReason
          ? `conditions_unmet:${conditionReason}`
          : decision.reason;
      return this.deps.store.recordRun({
        workspaceId: workflow.workspaceId,
        workflowId: workflow.id,
        trigger,
        status: "skipped",
        reason,
        results: [],
      });
    }

    // Execute each action (bounded by the per-run fan-out cap), collecting outcomes.
    const results: WorkflowActionResult[] = [];
    const actions = workflow.actions.slice(0, caps.maxActionsPerRun);
    for (const action of actions) {
      results.push(await this.executeAction(workflow, action));
    }

    // Roll the action outcomes up to a run status. Any failed action ⇒ failed (feeds the flywheel);
    // else if every executed action was blocked ⇒ blocked; else fired.
    const anyFailed = results.some((r) => r.status === "failed");
    const anyOk = results.some((r) => r.status === "ok");
    const status: WorkflowRunStatus = anyFailed ? "failed" : anyOk || results.length === 0 ? "fired" : "blocked";
    const reason = status === "fired" ? decision.reason : summarizeFailures(results);

    const run = await this.deps.store.recordRun({
      workspaceId: workflow.workspaceId,
      workflowId: workflow.id,
      trigger,
      status,
      reason,
      results,
    });

    if (status === "failed" && this.deps.flywheelRecord) {
      // A broken workflow fingerprints + dedupes like any other failure (#117). No channel/agent target
      // (a workflow is context-less for a fix agent), so it queues for a human.
      await this.deps
        .flywheelRecord({
          workspaceId: workflow.workspaceId,
          failureClass: "workflow_fail",
          message: `workflow "${workflow.name}" failed: ${reason}`,
          source: "workflow",
          detail: reason,
        })
        .catch((err) => this.deps.logger.warn({ err, workflowId: workflow.id }, "workflows flywheel feed failed"));
    }

    return run;
  }

  /** Execute one action through its existing gated seam, returning a recordable outcome. */
  private async executeAction(workflow: WorkflowRecord, action: WorkflowAction): Promise<WorkflowActionResult> {
    try {
      switch (action.kind) {
        case "agent_task":
          return await this.runAgentTask(workflow, action);
        case "draft_send":
          return await this.runDraftSend(workflow, action);
        case "notify_owner":
          return await this.runNotify(workflow, action);
        default:
          return { kind: action.kind, status: "blocked", reason: "unknown_action" };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : "action_failed";
      this.deps.logger.warn({ workflowId: workflow.id, kind: action.kind, reason }, "workflow action failed");
      return { kind: action.kind, status: "failed", reason };
    }
  }

  private async runAgentTask(workflow: WorkflowRecord, action: WorkflowAction): Promise<WorkflowActionResult> {
    if (!action.channelId) return { kind: "agent_task", status: "blocked", reason: "channel_missing" };
    if (!action.agentHandle) return { kind: "agent_task", status: "blocked", reason: "agent_missing" };
    const task = action.templateKey
      ? renderTemplate(action.templateKey, action.params ?? {})
      : (action.task ?? "").trim();
    if (!task) return { kind: "agent_task", status: "blocked", reason: "task_missing" };
    const member = await this.deps.resolveAgentMember(workflow.workspaceId, action.agentHandle);
    if (!member) return { kind: "agent_task", status: "blocked", reason: "agent_not_seeded" };

    // An admission denial (#71) or venture-gate rejection is a blocked action, not a crash.
    try {
      const session = await this.deps.launcher.launch({
        workspaceId: workflow.workspaceId,
        channelId: action.channelId,
        agentMemberId: member.agentMemberId,
        createdByMemberId: workflow.createdByMemberId,
        task,
        harnessEnv: { AGENT_WORKFLOW: "1" },
      });
      return { kind: "agent_task", status: "ok", reason: "launched", ref: session.id };
    } catch (err) {
      return { kind: "agent_task", status: "blocked", reason: err instanceof Error ? err.message : "launch_blocked" };
    }
  }

  private async runDraftSend(workflow: WorkflowRecord, action: WorkflowAction): Promise<WorkflowActionResult> {
    if (!action.sendKind) return { kind: "draft_send", status: "blocked", reason: "send_kind_missing" };
    if (!action.summary) return { kind: "draft_send", status: "blocked", reason: "summary_missing" };
    const submitted = await this.deps.draftSendGate.submit({
      workspaceId: workflow.workspaceId,
      requesterMemberId: workflow.createdByMemberId,
      sendKind: action.sendKind,
      summary: action.summary,
      target: action.target,
      amountCents: action.amountCents,
    });
    // The action created a PENDING #13 approval — nothing left the building.
    return { kind: "draft_send", status: "ok", reason: "approval_pending", ref: submitted.approvalRequestId };
  }

  private async runNotify(workflow: WorkflowRecord, action: WorkflowAction): Promise<WorkflowActionResult> {
    const message = (action.message ?? "").trim() || `Workflow "${workflow.name}" fired.`;
    const sent = await this.deps.notifier.notifyOwner({
      workspaceId: workflow.workspaceId,
      message,
      createdByMemberId: workflow.createdByMemberId,
    });
    return { kind: "notify_owner", status: "ok", reason: "notified", ref: sent.id };
  }
}

/** Build a compact reason string from the non-ok action outcomes. */
function summarizeFailures(results: WorkflowActionResult[]): string {
  const bad = results.filter((r) => r.status !== "ok").map((r) => `${r.kind}:${r.reason}`);
  return bad.length > 0 ? bad.join(", ") : "no_action_succeeded";
}

export { resolveWorkflowCaps };
