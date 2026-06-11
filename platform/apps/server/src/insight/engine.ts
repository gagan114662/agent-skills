import type { SessionLogger } from "../runtime/manager.js";
import type { InsightMiner } from "./service.js";

/**
 * The Insight Miner scheduled tick (#100 — infrastructure time). Modelled on the #96 `VentureEngine`:
 * an opt-in periodic timer (default off, started in `index.ts` only when `INSIGHT_INTERVAL_MS > 0`)
 * that runs one mining pass per workspace that has candidate sources. Each `mine` is itself gated by
 * the miner flag, the #17 kill switch, and the #71 dollar ceiling, so the engine stays thin — it only
 * supplies the schedule + the work-list. Tests drive the service's `mine()` directly.
 */
export interface InsightEngineDeps {
  miner: InsightMiner;
  /** Distinct workspaces with a candidate source — the timer's work-list. */
  listCandidateSourceWorkspaces: () => Promise<string[]>;
  logger: SessionLogger;
}

export class InsightEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: InsightEngineDeps) {}

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

  /** One mining pass over every workspace that currently has a candidate source. */
  async tickAll(): Promise<void> {
    const workspaceIds = await this.deps.listCandidateSourceWorkspaces();
    for (const workspaceId of workspaceIds) {
      try {
        await this.deps.miner.mine(workspaceId);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "insight tickAll: workspace mine failed");
      }
    }
  }
}
