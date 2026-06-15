import type { SessionLogger } from "../runtime/manager.js";
import { resolveAutomationCaps, type AutomationCaps } from "./caps.js";
import { decideAutomationRun } from "./decide.js";
import { computeNextRun, isDue } from "./schedule.js";
import { renderTemplate } from "./templates.js";
import type { AutomationRecord, AutomationRun, RunTrigger } from "./types.js";

/**
 * AutomationEngine (#147, ADR-0147) — a third infrastructure-time supervisor, mirroring the #105
 * watchdog / #117 flywheel wholesale. The opt-in `tickAll()`/`tickWorkspace()` find due automations and
 * launch each through the **same #123 venture-gated subagent launcher** a human @mention uses — so a
 * scheduled launch keeps the #96 venture gate + #71 budget/concurrency caps, and the launched agent is
 * a draft-only #123 persona (any external send still leaves through the #13 gate). `runAutomation` is
 * shared by the tick, the manual run-now route, and the webhook route.
 *
 * The decision is pure (`decide.ts`); every side effect (render, launch, record, advance the cursor) is
 * a seam here. Gating is identical to the watchdog: maintenance before any DB call, then per-workspace
 * the config `enabled` flag and the #17 kill switch.
 */

// ---- store seam (real impl wraps the `automations` / `automation_runs` repos) -------------------

export interface AutomationStore {
  create(input: {
    workspaceId: string;
    name: string;
    triggerKind: AutomationRecord["triggerKind"];
    schedule: AutomationRecord["schedule"];
    webhookTokenHash: string | null;
    templateKey: string;
    params: Record<string, string>;
    channelId: string;
    agentHandle: string;
    enabled: boolean;
    createdByMemberId: string;
    nextRunAt: Date | null;
  }): Promise<AutomationRecord>;
  get(workspaceId: string, id: string): Promise<AutomationRecord | null>;
  list(workspaceId: string): Promise<AutomationRecord[]>;
  countForWorkspace(workspaceId: string): Promise<number>;
  setEnabled(workspaceId: string, id: string, enabled: boolean, nextRunAt: Date | null): Promise<AutomationRecord | null>;
  remove(workspaceId: string, id: string): Promise<boolean>;
  /** Enabled schedule automations whose cursor is due (`enabled AND next_run_at <= now`). */
  listDue(workspaceId: string, now: Date): Promise<AutomationRecord[]>;
  /** Advance the scheduler cursor after a due automation is processed. */
  markRan(input: { id: string; lastRunAt: Date; nextRunAt: Date | null }): Promise<void>;
  /** Append a run-ledger row. */
  recordRun(input: {
    workspaceId: string;
    automationId: string;
    trigger: RunTrigger;
    status: AutomationRun["status"];
    reason: string;
    sessionId: string | null;
    task: string;
  }): Promise<AutomationRun>;
  /** Count `launched` runs for a workspace since `since` (the per-tenant rate-limit input). */
  countRunsInWindow(workspaceId: string, since: Date): Promise<number>;
  /** Resolve a webhook automation by its token hash (cross-workspace — carries its own workspaceId). */
  findByWebhookHash(hash: string): Promise<AutomationRecord | null>;
  /** Workspaces with at least one enabled schedule automation (the tick work-list). */
  activeWorkspaces(): Promise<string[]>;
}

/** The session-launch surface — the #123 venture-gated subagent launcher satisfies it. */
export interface AutomationLauncher {
  launch(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    task: string;
    harnessEnv?: Record<string, string>;
  }): Promise<{ id: string }>;
}

export interface AutomationEngineDeps {
  store: AutomationStore;
  launcher: AutomationLauncher;
  /** Resolve the #123 department persona's agent member id from its handle, or null if not seeded. */
  resolveAgentMember: (workspaceId: string, handle: string) => Promise<{ agentMemberId: string } | null>;
  /** Resolve the per-workspace automations caps (config; default OFF). */
  caps: (workspaceId: string) => AutomationCaps;
  /** The #17 kill switch for a workspace (halts its tick). */
  killSwitch: (workspaceId: string) => Promise<boolean>;
  /**
   * Resolve the workspace's real public site URL for the `{{site}}` template variable (#250). Optional —
   * absent (or returning undefined) ⇒ the template keeps its `"our website"` placeholder, today's
   * behavior. Wired in production from `resolveSiteUrl(marketing config)`. A stored `params.site` set by
   * the owner always wins over this default.
   */
  resolveSiteUrl?: (workspaceId: string) => string | undefined;
  /** Optional maintenance-pause check (#99) — when true, `tickAll()` skips BEFORE any DB call. */
  maintenancePaused?: () => Promise<boolean>;
  logger: SessionLogger;
  /** Clock seam — defaults to `new Date()`; tests inject a fixed clock. */
  now?: () => Date;
}

export class AutomationEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: AutomationEngineDeps) {}

  private clock(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Start the periodic loop. No-op if interval ≤ 0 or already started. */
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

  /** One pass over every workspace with enabled schedule automations. */
  async tickAll(): Promise<void> {
    // #99: maintenance pauses the whole loop on the same Redis flag the HTTP write-gate reads — checked
    // BEFORE any DB call so a maintenance window stops all automation work immediately.
    if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) {
      this.deps.logger.warn({}, "automations tickAll skipped: maintenance mode active");
      return;
    }
    const now = this.clock();
    const workspaces = await this.deps.store.activeWorkspaces();
    for (const workspaceId of workspaces) {
      try {
        await this.tickWorkspace(workspaceId, now);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "automations tickAll: workspace tick failed");
      }
    }
  }

  /**
   * One pass over a single workspace: launch each due automation (rate-capped), advancing each
   * scheduler cursor. The config flag and the kill switch gate the whole pass first (mirrors the
   * watchdog) — a disabled or halted workspace does no work and writes no rows.
   */
  async tickWorkspace(workspaceId: string, now: Date): Promise<{ workspaceId: string; runs: AutomationRun[]; skipped?: "disabled" | "kill_switch" }> {
    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return { workspaceId, runs: [], skipped: "disabled" };
    if (await this.deps.killSwitch(workspaceId)) {
      this.deps.logger.warn({ workspaceId }, "automations tick skipped: kill switch engaged");
      return { workspaceId, runs: [], skipped: "kill_switch" };
    }

    const due = await this.deps.store.listDue(workspaceId, now);
    const runs: AutomationRun[] = [];
    for (const automation of due) {
      const run = await this.runAutomation(automation, "schedule", now, { capsEnabled: true, killSwitch: false });
      runs.push(run);
      // Advance the cursor whether we launched or rate-skipped, so the same slot never re-fires.
      const nextRunAt = automation.schedule ? computeNextRun(automation.schedule, now) : null;
      await this.deps.store.markRan({ id: automation.id, lastRunAt: now, nextRunAt });
    }
    this.deps.logger.info({ workspaceId, runs: runs.length }, "automations tick complete");
    return { workspaceId, runs };
  }

  /**
   * Evaluate + (maybe) launch one automation, recording a durable run. Shared by the tick, manual
   * run-now, and the webhook route. Resolves every async fact, then the pure `decideAutomationRun`
   * makes the single call; a `run` renders the template and launches through the gated launcher.
   * `gates` lets the tick skip the per-automation caps/kill re-resolve it already did at pass level.
   */
  async runAutomation(
    automation: AutomationRecord,
    trigger: RunTrigger,
    now: Date = this.clock(),
    gates?: { capsEnabled: boolean; killSwitch: boolean },
  ): Promise<AutomationRun> {
    const caps = this.deps.caps(automation.workspaceId);
    const capsEnabled = gates?.capsEnabled ?? caps.enabled;
    const killSwitch = gates?.killSwitch ?? (await this.deps.killSwitch(automation.workspaceId));
    const since = new Date(now.getTime() - caps.windowMinutes * 60_000);
    const runsInWindow = await this.deps.store.countRunsInWindow(automation.workspaceId, since);
    const due = trigger === "schedule" ? isDue(automation.nextRunAt, now) : true;

    const decision = decideAutomationRun({
      capsEnabled,
      automationEnabled: automation.enabled,
      killSwitch,
      due,
      runsInWindow,
      maxRunsPerWindow: caps.maxRunsPerWindow,
    });

    if (decision.action === "skip") {
      return this.deps.store.recordRun({
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        trigger,
        status: "skipped",
        reason: decision.reason,
        sessionId: null,
        task: "",
      });
    }

    const member = await this.deps.resolveAgentMember(automation.workspaceId, automation.agentHandle);
    // #250: default the `{{site}}` param to the workspace's real site URL so a seeded SEO task points the
    // fleet at a real domain (not the "our website" placeholder). An owner-supplied `params.site` wins.
    const site = this.deps.resolveSiteUrl?.(automation.workspaceId);
    const params = site ? { site, ...automation.params } : automation.params;
    const task = renderTemplate(automation.templateKey, params);
    if (!member) {
      return this.recordBlocked(automation, trigger, "agent_not_seeded", task);
    }
    if (!task) {
      return this.recordBlocked(automation, trigger, "template_missing", task);
    }

    try {
      const session = await this.deps.launcher.launch({
        workspaceId: automation.workspaceId,
        channelId: automation.channelId,
        agentMemberId: member.agentMemberId,
        createdByMemberId: automation.createdByMemberId,
        task,
        harnessEnv: { AGENT_AUTOMATION: "1" },
      });
      this.deps.logger.info(
        { workspaceId: automation.workspaceId, automationId: automation.id, sessionId: session.id },
        "automation launched",
      );
      return this.deps.store.recordRun({
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        trigger,
        status: "launched",
        reason: decision.reason,
        sessionId: session.id,
        task,
      });
    } catch (err) {
      // An admission denial (#71 budget/concurrency/kill) or venture-gate rejection never crashes the
      // tick — it is recorded as a blocked run so the owner sees why nothing launched.
      const reason = err instanceof Error ? err.message : "launch_failed";
      this.deps.logger.warn(
        { workspaceId: automation.workspaceId, automationId: automation.id, reason },
        "automation launch blocked",
      );
      return this.recordBlocked(automation, trigger, reason, task);
    }
  }

  private recordBlocked(
    automation: AutomationRecord,
    trigger: RunTrigger,
    reason: string,
    task: string,
  ): Promise<AutomationRun> {
    return this.deps.store.recordRun({
      workspaceId: automation.workspaceId,
      automationId: automation.id,
      trigger,
      status: "blocked",
      reason,
      sessionId: null,
      task,
    });
  }
}

export { resolveAutomationCaps };
