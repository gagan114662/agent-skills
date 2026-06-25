import type { SessionLogger } from "../runtime/manager.js";
import { isVentureGateEnabledForWorkspace, type VentureCaps } from "./caps.js";
import type { VentureService } from "./service.js";

/**
 * The Venture Loop scheduled tick (#96 hardening — infrastructure time). Modelled on the #17
 * AutonomyEngine: an opt-in periodic timer (default off, started in `index.ts` only when
 * `VENTURE_INTERVAL_MS > 0`) that advances every workspace's active evaluations one step per tick.
 * Each `advance` is itself gated by the #17 kill switch and the dollar ceiling, so the engine stays
 * thin — it only supplies the schedule + the work-list. Tests drive `tick()`/`tickAll()` directly.
 */
export interface VentureEngineDeps {
  service: VentureService;
  /** Distinct workspaces with an active evaluation — the timer's work-list. */
  listActiveEvaluationWorkspaces: () => Promise<string[]>;
  /** Workspace-scoped feature policy; disabled/unnamed owners do not receive autonomous ticks. */
  caps: (workspaceId: string) => VentureCaps;
  logger: SessionLogger;
}

export class VentureEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: VentureEngineDeps) {}

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

  /** One pass over every workspace that currently has an active evaluation. */
  async tickAll(): Promise<void> {
    const workspaceIds = await this.deps.listActiveEvaluationWorkspaces();
    for (const workspaceId of workspaceIds) {
      if (!isVentureGateEnabledForWorkspace(this.deps.caps(workspaceId), workspaceId)) continue;
      try {
        await this.deps.service.tick(workspaceId);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "venture tickAll: workspace tick failed");
      }
    }
  }
}
