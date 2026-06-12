import type { SessionLogger } from "../runtime/manager.js";

/**
 * The proactive digest tick (#170). An opt-in periodic timer (default OFF, started in `index.ts` only
 * when `SLACK_DIGEST_INTERVAL_MS > 0`), mirroring the #105 watchdog / #112 SRE engines: pure-ish, every
 * IO is a seam, tests drive `tickWorkspace` directly. Each tick DMs the daily fleet digest to the owner
 * of every workspace whose `slack.digestEnabled` is on (default-OFF). Best-effort per workspace — one
 * tenant's failure never blocks the rest. Stopped on server close so no timer leaks past shutdown.
 */
export interface SlackDigestEngineDeps {
  /** Every workspace id (the work-list). */
  listWorkspaceIds(): Promise<string[]>;
  /** Whether a workspace opted into the daily digest DM (`slack.digestEnabled`, default OFF). */
  digestEnabled(workspaceId: string): boolean;
  /** Whether maintenance mode is active (#99) — pauses all proactive work. */
  maintenancePaused(): Promise<boolean> | boolean;
  /** Build + DM the digest for a workspace. */
  sendDigest(workspaceId: string): Promise<{ sent: boolean }>;
  logger: SessionLogger;
}

export class SlackDigestEngine {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: SlackDigestEngineDeps) {}

  /** Start the periodic loop. No-op if interval ≤ 0 or already started. */
  start(intervalMs: number): void {
    if (intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.tickAll(), intervalMs);
  }

  /** Stop the loop (called on server close). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One pass over every workspace, best-effort. */
  async tickAll(): Promise<void> {
    if (await this.deps.maintenancePaused()) return;
    let workspaceIds: string[];
    try {
      workspaceIds = await this.deps.listWorkspaceIds();
    } catch (err) {
      this.deps.logger.error({ err }, "slack digest: failed to list workspaces");
      return;
    }
    for (const workspaceId of workspaceIds) {
      try {
        await this.tickWorkspace(workspaceId);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "slack digest tick failed");
      }
    }
  }

  /** Send one workspace's digest if it opted in. Returns the outcome (skipped when not enabled). */
  async tickWorkspace(workspaceId: string): Promise<{ skipped: true } | { sent: boolean }> {
    if (!this.deps.digestEnabled(workspaceId)) return { skipped: true };
    return this.deps.sendDigest(workspaceId);
  }
}
