import type { SessionLogger } from "../runtime/manager.js";

export interface ApprovalExpiryStore {
  listWorkspaceIds(): Promise<string[]>;
  sweepExpired(workspaceId: string): Promise<number>;
}

export interface ApprovalExpiryTickResult {
  workspaces: number;
  expired: number;
}

export interface ApprovalExpiryEngineDeps {
  store: ApprovalExpiryStore;
  logger: Pick<SessionLogger, "info" | "error">;
}

/**
 * Periodic approval-expiry sweeper (#951). The repository keeps expiry atomic per workspace; this engine
 * supplies the missing infrastructure timer and work-list so pending requests honor their TTL without a
 * human manually hitting the route.
 */
export class ApprovalExpiryEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: ApprovalExpiryEngineDeps) {}

  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.tickAll().catch((err) => {
        this.deps.logger.error({ err }, "approval expiry sweep failed");
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tickAll(): Promise<ApprovalExpiryTickResult> {
    const workspaceIds = await this.deps.store.listWorkspaceIds();
    let expired = 0;
    for (const workspaceId of workspaceIds) {
      try {
        expired += await this.deps.store.sweepExpired(workspaceId);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "approval expiry sweep failed for workspace");
      }
    }
    if (expired > 0) {
      this.deps.logger.info({ workspaces: workspaceIds.length, expired }, "approval expiry sweep expired requests");
    }
    return { workspaces: workspaceIds.length, expired };
  }
}
