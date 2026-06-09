import type { ResourceCaps, RuntimeKind } from "./db/repositories/agent-sessions.js";
import { harnessSpec, parseHarnessKind, type HarnessKind } from "./runtime/harness.js";

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
  /** Team Mode: parallel multi-agent runs. */
  team: TeamEnv;
  /** Persistent & shared cloud workspaces (#55). */
  cloud: CloudEnv;
}

export interface CloudEnv {
  /**
   * Idle-sweep interval in ms. Default `0` = the background sweep is OFF (opt-in), mirroring the
   * #17 loop — tests drive `sweepIdle()` deterministically.
   */
  sweepIntervalMs: number;
  /** A cloud workspace idle longer than this is slept by the sweep. Default 30 min. */
  idleMs: number;
}

export interface TeamEnv {
  /**
   * Max agent sessions a team run keeps in flight at once — the team-level cap that keeps us under
   * the sandbox budget. Per-session ResourceCaps still apply on top of this. Default 3.
   */
  maxConcurrency: number;
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
  /** Which coding-agent harness runs each session (#50). Default `demo` (no model spend). */
  harness: HarnessKind;
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
    agent: (() => {
      // Select the coding-agent harness (#50). Default `demo` keeps tests/CI free of model spend;
      // `claude-code` runs the real Claude Code CLI. Explicit AGENT_HARNESS_CMD/ARGS still override.
      const harness = parseHarnessKind(source.AGENT_HARNESS);
      const spec = harnessSpec(harness, {
        claudeBin: source.CLAUDE_BIN,
        model: source.ANTHROPIC_MODEL,
      });
      return {
        runtime: parseRuntime(source.AGENT_RUNTIME),
        harness,
        harnessCommand: source.AGENT_HARNESS_CMD ?? spec.command,
        harnessArgs: source.AGENT_HARNESS_ARGS
          ? JSON.parse(source.AGENT_HARNESS_ARGS)
          : spec.args,
        caps: {
          wallClockMs: num(source.AGENT_WALLCLOCK_MS, 600_000),
          idleMs: num(source.AGENT_IDLE_MS, 120_000),
          memoryMb: source.AGENT_MEMORY_MB ? num(source.AGENT_MEMORY_MB, 512) : undefined,
        },
      };
    })(),
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
    team: {
      maxConcurrency: num(source.TEAM_MAX_CONCURRENCY, 3),
    },
    cloud: {
      // Default 0 (off): the idle sweep is opt-in so tests/CI drive `sweepIdle()` deterministically.
      sweepIntervalMs: Number(source.CLOUD_SWEEP_INTERVAL_MS ?? 0) || 0,
      idleMs: num(source.CLOUD_IDLE_MS, 1_800_000),
    },
  };
}
