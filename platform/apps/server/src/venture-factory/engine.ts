import type { SessionLogger } from "../runtime/manager.js";
import type { VentureFactoryAdvanceResult, VentureFactoryService } from "./service.js";

/**
 * The Venture Factory scheduled tick (#187 AC1 — the continuous opportunity scanner). Modelled on the
 * #100 `InsightEngine`: an opt-in periodic timer (default off, started in `index.ts` only when
 * `VENTURE_FACTORY_INTERVAL_MS > 0`) that runs one autopilot pass per workspace with `scanned`
 * candidates. Each pass is itself gated (enabled / owner-scope / kill switch) inside the service, so the
 * engine stays thin — it only supplies the schedule + the work-list. Tests drive the service directly.
 */
export interface VentureFactoryEngineDeps {
  factory: VentureFactoryService;
  /** Distinct workspaces with a `scanned` candidate — the timer's work-list. */
  listFactoryWorkspaces: () => Promise<string[]>;
  /** Resolve the AGENT member that owns the autonomous request in a workspace (the #13 FK requirement). */
  requesterMemberId: (workspaceId: string) => Promise<string | null>;
  logger: SessionLogger;
}

export class VentureFactoryEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: VentureFactoryEngineDeps) {}

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

  /** One autopilot pass over every workspace that currently has a `scanned` candidate. */
  async tickAll(): Promise<VentureFactoryAdvanceResult[]> {
    const workspaceIds = await this.deps.listFactoryWorkspaces();
    const results: VentureFactoryAdvanceResult[] = [];
    for (const workspaceId of workspaceIds) {
      try {
        const requesterMemberId = await this.deps.requesterMemberId(workspaceId);
        if (!requesterMemberId) continue; // no AGENT member to own the request → skip (no human-owned ws)
        results.push(await this.deps.factory.advanceWorkspace(workspaceId, { requesterMemberId }));
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "venture-factory tickAll: workspace advance failed");
      }
    }
    return results;
  }
}
