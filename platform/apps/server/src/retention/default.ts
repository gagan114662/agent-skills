import type { FastifyBaseLogger } from "fastify";
import { loadEnv, type RetentionEnv } from "../env.js";
import { pruneTerminalAgentSessionsBefore } from "../db/repositories/agent-sessions.js";

export interface RetentionSweepReport {
  cutoff: Date | null;
  prunedSessions: number;
  disabled: boolean;
}

export interface RetentionDeps {
  config?: RetentionEnv;
  now?: () => Date;
  pruneSessions?: (cutoff: Date, limit: number) => Promise<string[]>;
  logger?: Pick<FastifyBaseLogger, "info" | "error">;
}

const DAY_MS = 86_400_000;

export async function sweepRetention(deps: RetentionDeps = {}): Promise<RetentionSweepReport> {
  const config = deps.config ?? loadEnv().retention;
  if (config.runRetentionDays <= 0) return { cutoff: null, prunedSessions: 0, disabled: true };
  const now = deps.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - config.runRetentionDays * DAY_MS);
  const prune = deps.pruneSessions ?? pruneTerminalAgentSessionsBefore;
  const pruned = await prune(cutoff, config.batchSize);
  deps.logger?.info({ cutoff: cutoff.toISOString(), prunedSessions: pruned.length }, "data retention pruned old run data");
  return { cutoff, prunedSessions: pruned.length, disabled: false };
}

export function startRetentionLoop(deps: RetentionDeps = {}): { stop(): void } {
  const config = deps.config ?? loadEnv().retention;
  if (config.runRetentionDays <= 0 || config.intervalMs <= 0) return { stop() {} };
  const run = (): void => {
    void sweepRetention(deps).catch((err) => deps.logger?.error({ err }, "data retention sweep failed"));
  };
  run();
  const timer = setInterval(run, config.intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
