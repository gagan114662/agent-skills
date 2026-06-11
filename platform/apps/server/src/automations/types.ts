/**
 * Shared types for Automations (#147, ADR-0147). The pure `schedule`/`templates`/`caps`/`decide`
 * modules and the IO `engine` agree on these — mirroring the #105 watchdog / #117 flywheel split
 * (pure decision in, side effects out). The trigger model is deliberately small + data-driven so #152
 * (the workflow builder) can widen it without touching the launch path.
 */

/** How an automation fires. `schedule` is cursor-driven (`next_run_at`); `webhook` is token-driven. */
export const TRIGGER_KINDS = ["schedule", "webhook"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export function isTriggerKind(value: unknown): value is TriggerKind {
  return typeof value === "string" && (TRIGGER_KINDS as readonly string[]).includes(value);
}

/** What actually caused a run (a manual "run now" is distinct from the scheduler/webhook). */
export const RUN_TRIGGERS = ["schedule", "webhook", "manual"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** The outcome of a run attempt (the durable `automation_runs.status`). */
export const RUN_STATUSES = ["launched", "skipped", "blocked", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The small enum of schedule cadences. UTC. #152 widens this (add cadences / a cron field). */
export const CADENCES = ["interval", "hourly", "daily", "weekly"] as const;
export type Cadence = (typeof CADENCES)[number];

/**
 * A data-driven schedule spec (stored as `automations.schedule` jsonb). Only the fields a cadence uses
 * are read:
 *  - `interval` → `everyMinutes`
 *  - `hourly`   → `minute`
 *  - `daily`    → `hour` + `minute`
 *  - `weekly`   → `dayOfWeek` (0=Sun…6=Sat) + `hour` + `minute`
 * Absent fields default to 0. A clock seam (not wall-clock) drives `computeNextRun`, so it is pure.
 */
export interface ScheduleSpec {
  cadence: Cadence;
  /** `interval` cadence: minutes between runs (min 1). */
  everyMinutes?: number;
  /** `weekly` cadence: 0=Sunday … 6=Saturday. */
  dayOfWeek?: number;
  /** `daily`/`weekly` cadence: hour of day, 0–23 (UTC). */
  hour?: number;
  /** `hourly`/`daily`/`weekly` cadence: minute of hour, 0–59. */
  minute?: number;
}

/** A durable automation definition (one `automations` row). */
export interface AutomationRecord {
  id: string;
  workspaceId: string;
  name: string;
  triggerKind: TriggerKind;
  /** The cadence spec for a `schedule` trigger (ignored for `webhook`). */
  schedule: ScheduleSpec | null;
  /** The task template key (see `templates.ts`) the run renders. */
  templateKey: string;
  /** Flat param bag substituted into the template body. */
  params: Record<string, string>;
  channelId: string;
  /** The #123 department persona handle the run launches as (e.g. `scout`). */
  agentHandle: string;
  enabled: boolean;
  createdByMemberId: string;
  lastRunAt: Date | null;
  /** The scheduler cursor: the next time a `schedule` automation is due (null for webhook). */
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A durable run-ledger row (one `automation_runs` row). */
export interface AutomationRun {
  id: string;
  workspaceId: string;
  automationId: string;
  trigger: RunTrigger;
  status: RunStatus;
  reason: string;
  /** The launched session (soft reference — a run outlives a pruned session), or null. */
  sessionId: string | null;
  task: string;
  createdAt: Date;
}

/** The pure run decision input — every async fact the engine resolved up front. */
export interface AutomationRunDecisionInput {
  /** The per-tenant automations flag (config; default OFF). */
  capsEnabled: boolean;
  /** This automation's own `enabled` flag. */
  automationEnabled: boolean;
  /** The #17 kill switch for the workspace. */
  killSwitch: boolean;
  /** Whether the trigger is due (scheduler: `next_run_at <= now`; manual/webhook: always true). */
  due: boolean;
  /** Runs recorded for this workspace inside the rate window. */
  runsInWindow: number;
  /** The per-tenant cap on runs per window. */
  maxRunsPerWindow: number;
}

export type RunAction = "run" | "skip";

export interface AutomationRunDecision {
  action: RunAction;
  reason: string;
}
