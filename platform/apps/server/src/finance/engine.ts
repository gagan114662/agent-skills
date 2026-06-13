import type { SessionLogger } from "../runtime/manager.js";
import type { FinanceService } from "./service.js";
import type { FinanceCaps } from "./caps.js";

/**
 * FinanceLedgerEngine (#194, ADR-0194) — the scheduled tick that makes the books close themselves.
 * Mirrors the #173 founder-briefings engine / #105 watchdog: an opt-in periodic timer (default OFF,
 * started in `index.ts` only when `FINANCE_INTERVAL_MS > 0`) whose `tickAll()` lists the workspaces
 * and, for each that has finance enabled, `sync()`s new external receipts into the ledger and refreshes
 * the current period's close pack.
 *
 * Gating mirrors the platform: maintenance (#99) pauses the WHOLE pass before any work; the per-workspace
 * `finance.enabled` caps flag (default OFF) skips a workspace entirely. The engine only schedules +
 * iterates; the posting/close side effects live in the service, and NONE of them move money.
 */
export interface FinanceEngineDeps {
  service: FinanceService;
  /** The work-list: every workspace. */
  listWorkspaceIds: () => Promise<string[]>;
  /** Per-workspace caps — the `enabled` gate. */
  caps: (workspaceId: string) => FinanceCaps;
  /** Optional maintenance-pause check (#99). True ⇒ skip the whole pass. */
  maintenancePaused?: () => Promise<boolean>;
  logger: SessionLogger;
  now?: () => Date;
}

export interface WorkspaceFinanceResult {
  workspaceId: string;
  revenuePosted: number;
  costPosted: number;
  closed: number;
}

export class FinanceLedgerEngine {
  private timer?: NodeJS.Timeout;
  constructor(private readonly deps: FinanceEngineDeps) {}

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
      this.deps.logger.warn({}, "finance tickAll skipped: maintenance mode active");
      return;
    }
    const workspaceIds = await this.deps.listWorkspaceIds();
    for (const workspaceId of workspaceIds) {
      try {
        await this.tickWorkspace(workspaceId);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "finance: workspace tick failed");
      }
    }
  }

  /**
   * Sync receipts + refresh the current period's close for one workspace. A no-op when finance is
   * disabled for the workspace. Exposed so tests drive a tick with no timer.
   */
  async tickWorkspace(workspaceId: string): Promise<WorkspaceFinanceResult> {
    if (!this.deps.caps(workspaceId).enabled) {
      return { workspaceId, revenuePosted: 0, costPosted: 0, closed: 0 };
    }
    const sync = await this.deps.service.sync(workspaceId);
    const packs = await this.deps.service.close(workspaceId);
    return {
      workspaceId,
      revenuePosted: sync.revenuePosted,
      costPosted: sync.costPosted,
      closed: packs.length,
    };
  }
}
