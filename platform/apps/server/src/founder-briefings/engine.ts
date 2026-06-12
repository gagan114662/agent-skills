import type { SessionLogger } from "../runtime/manager.js";
import {
  dailyPeriodKey,
  weeklyPeriodKey,
  type DeliveryOutcome,
  type FounderBriefingsService,
} from "./service.js";

/**
 * FounderBriefingsEngine (#173, ADR-0173) — the scheduled reporting tick that pushes the daily brief +
 * weekly founder report to each workspace owner. Mirrors the #105 watchdog / #112 SRE supervisor: an
 * opt-in periodic timer (default OFF, started in `index.ts` only when `BRIEFINGS_INTERVAL_MS > 0`) whose
 * `tickAll()` lists the workspaces and delivers each digest for the current period.
 *
 * Gating mirrors the platform: maintenance (#99) pauses the whole pass BEFORE any work; the per-workspace
 * `briefings.enabled` caps flag (checked inside the service) is default OFF; and the idempotency watermark
 * makes a repeat tick in the same period a no-op (so a 1-hour interval still sends ONE daily brief / day).
 * The delivery side effects live in the service; the engine only schedules + iterates.
 */
export interface FounderBriefingsEngineDeps {
  service: FounderBriefingsService;
  /** The work-list: every workspace (the company reports to every owner who opted in). */
  listWorkspaceIds: () => Promise<string[]>;
  /** Optional maintenance-pause check (#99). True ⇒ skip the whole pass. */
  maintenancePaused?: () => Promise<boolean>;
  logger: SessionLogger;
  /** Clock seam — defaults to `new Date()`; tests inject a fixed clock. */
  now?: () => Date;
}

export interface WorkspaceBriefingResult {
  workspaceId: string;
  daily: DeliveryOutcome;
  weekly: DeliveryOutcome;
}

export class FounderBriefingsEngine {
  private timer?: NodeJS.Timeout;
  constructor(private readonly deps: FounderBriefingsEngineDeps) {}

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

  /** One pass over every workspace. Maintenance pauses the whole pass before any work. */
  async tickAll(): Promise<void> {
    if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) {
      this.deps.logger.warn({}, "founder-briefings tickAll skipped: maintenance mode active");
      return;
    }
    const now = this.deps.now?.() ?? new Date();
    const workspaceIds = await this.deps.listWorkspaceIds();
    for (const workspaceId of workspaceIds) {
      try {
        await this.tickWorkspace(workspaceId, now);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "founder-briefings: workspace tick failed");
      }
    }
  }

  /**
   * Deliver both digests for one workspace at `now`. Each call is a no-op when the caps flag is off or
   * the digest was already sent this period (the watermark). Exposed so tests drive delivery with no timer.
   */
  async tickWorkspace(workspaceId: string, now: Date): Promise<WorkspaceBriefingResult> {
    const daily = await this.deps.service.deliverDaily(workspaceId, dailyPeriodKey(now));
    const weekly = await this.deps.service.deliverWeekly(workspaceId, weeklyPeriodKey(now));
    return { workspaceId, daily, weekly };
  }
}
