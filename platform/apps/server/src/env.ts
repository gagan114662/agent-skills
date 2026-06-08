import type { ResourceCaps, RuntimeKind } from "./db/repositories/agent-sessions.js";

/** Environment configuration with local-dev defaults matching docker-compose.yml. */
export interface Env {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** Cloud agent execution (#25). */
  agent: AgentEnv;
  /** Autonomous activity loop (#17). */
  autonomy: AutonomyEnv;
  /** Notifications (#8). */
  notify: NotifyEnv;
  /** Approval gates (#13). */
  approval: ApprovalEnv;
}

export interface AutonomyEnv {
  /** Periodic loop interval in ms. Default `0` = the background timer is OFF (opt-in). */
  intervalMs: number;
}

export interface NotifyEnv {
  /** External transport: when set, notifications are POSTed here; unset → no-op transport. */
  webhookUrl?: string;
}

export interface ApprovalEnv {
  /** Default TTL (seconds) after which an undecided request expires. Override per request. */
  defaultTtlSeconds: number;
}

export interface AgentEnv {
  /** Execution backend. Default `local` so tests/CI need no cloud spend. */
  runtime: RuntimeKind;
  /** The trusted harness command + args run for each session (NOT client-supplied). */
  harnessCommand: string;
  harnessArgs: string[];
  /** Hard per-session resource + wall-clock caps. */
  caps: ResourceCaps;
}

function parseRuntime(value: string | undefined): RuntimeKind {
  return value === "sandbox" ? "sandbox" : "local";
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return {
    port: Number(source.PORT ?? 3000),
    databaseUrl: source.DATABASE_URL ?? "postgres://reload:reload@localhost:5433/reload",
    redisUrl: source.REDIS_URL ?? "redis://localhost:6379",
    agent: {
      runtime: parseRuntime(source.AGENT_RUNTIME),
      // Dev/demo default: a tiny built-in harness that echoes the task as a few lines of "work".
      harnessCommand: source.AGENT_HARNESS_CMD ?? "bash",
      harnessArgs: source.AGENT_HARNESS_ARGS
        ? JSON.parse(source.AGENT_HARNESS_ARGS)
        : ["scripts/agent-harness-demo.sh"],
      caps: {
        wallClockMs: num(source.AGENT_WALLCLOCK_MS, 600_000),
        idleMs: num(source.AGENT_IDLE_MS, 120_000),
        memoryMb: source.AGENT_MEMORY_MB ? num(source.AGENT_MEMORY_MB, 512) : undefined,
      },
    },
    autonomy: {
      // Default 0 (off): the background loop is opt-in so tests/CI drive `tick()` deterministically.
      intervalMs: Number(source.AUTONOMY_INTERVAL_MS ?? 0) || 0,
    },
    notify: {
      webhookUrl: source.NOTIFY_WEBHOOK_URL || undefined,
    },
    approval: {
      defaultTtlSeconds: num(source.APPROVAL_TTL_SECONDS, 86_400),
    },
  };
}
