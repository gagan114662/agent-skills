import type { FastifyBaseLogger } from "fastify";

export interface AuthSessionCleanupConfig {
  intervalMs: number;
  batchSize: number;
}

export interface AuthSessionCleanupStore {
  deleteExpiredSessions(input: { now: Date; limit: number }): Promise<number>;
}

export interface AuthSessionCleanupDeps {
  config: AuthSessionCleanupConfig;
  store: AuthSessionCleanupStore;
  logger: Pick<FastifyBaseLogger, "info" | "error">;
  now?: () => Date;
}

export class AuthSessionCleanupEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: AuthSessionCleanupDeps) {}

  start(intervalMs = this.deps.config.intervalMs): void {
    if (this.timer || intervalMs <= 0) return;
    const run = (): void => {
      void this.tick().catch((err) => {
        this.deps.logger.error({ err }, "auth session cleanup failed");
      });
    };
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<{ deleted: number }> {
    const deleted = await this.deps.store.deleteExpiredSessions({
      now: this.deps.now?.() ?? new Date(),
      limit: this.deps.config.batchSize,
    });
    this.deps.logger.info({ deleted }, "auth session cleanup removed expired sessions");
    return { deleted };
  }
}
