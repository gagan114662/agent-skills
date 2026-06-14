import type { SessionLogger } from "../runtime/manager.js";
import type { MonetizationService } from "./service.js";
import type { MonetizationCaps } from "./caps.js";

/**
 * MonetizationEngine (#188, ADR-0188) — the scheduled tick that mints a venture's REAL payment links
 * once the owner has approved their activation. Mirrors the #194 finance engine / #105 watchdog: an
 * opt-in periodic timer (default OFF, started in `index.ts` only when `MONETIZATION_INTERVAL_MS > 0`)
 * whose `tickAll()` lists the workspaces and, for each with monetization enabled, calls
 * `activatePending()` — which mints links ONLY for plans whose #13 money decision is `executed`.
 *
 * Gating mirrors the platform: maintenance (#99) pauses the whole pass before any work; the per-workspace
 * `monetization.enabled` caps flag (default OFF) skips a workspace. The engine only schedules + iterates;
 * the minting (inbound-only collection) lives in the service and never moves money out.
 */
export interface MonetizationEngineDeps {
  service: MonetizationService;
  /** The work-list: every workspace. */
  listWorkspaceIds: () => Promise<string[]>;
  /** Per-workspace caps — the `enabled` gate. */
  caps: (workspaceId: string) => MonetizationCaps;
  /** Optional maintenance-pause check (#99). True ⇒ skip the whole pass. */
  maintenancePaused?: () => Promise<boolean>;
  logger: SessionLogger;
}

export interface WorkspaceMonetizationResult {
  workspaceId: string;
  activated: number;
}

export class MonetizationEngine {
  private timer?: NodeJS.Timeout;
  constructor(private readonly deps: MonetizationEngineDeps) {}

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
      this.deps.logger.warn({}, "monetization tickAll skipped: maintenance mode active");
      return;
    }
    const workspaceIds = await this.deps.listWorkspaceIds();
    for (const workspaceId of workspaceIds) {
      try {
        await this.tickWorkspace(workspaceId);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "monetization: workspace tick failed");
      }
    }
  }

  /**
   * Mint links for one workspace's owner-approved activations. A no-op when monetization is disabled.
   * Exposed so tests drive a tick with no timer.
   */
  async tickWorkspace(workspaceId: string): Promise<WorkspaceMonetizationResult> {
    if (!this.deps.caps(workspaceId).enabled) {
      return { workspaceId, activated: 0 };
    }
    const { activated } = await this.deps.service.activatePending(workspaceId);
    return { workspaceId, activated: activated.length };
  }
}
