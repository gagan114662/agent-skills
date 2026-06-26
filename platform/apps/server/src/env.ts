import { hostname } from "node:os";
import type { ResourceCaps, RuntimeKind } from "./db/repositories/agent-sessions.js";
import { harnessSpec, parseHarnessKind, type HarnessKind } from "./runtime/harness.js";
import { parseProfile, profilePreset, type ProfileName } from "./runtime/posture.js";
import type { SandboxGitSource } from "./runtime/sandbox.js";
import type { BillingMode } from "./billing/mode.js";
import { ConfigValidationError } from "./config/loader.js";

/** Environment configuration with local-dev defaults matching docker-compose.yml. */
export interface Env {
  port: number;
  databaseUrl: string;
  /**
   * Postgres connection-pool size — a worker-concurrency knob that bounds how much DB-bound work one
   * server process can do at once (the per-replica capacity ceiling for horizontal scale-out, #113).
   * Default 10 (the prior hard-coded value).
   */
  databasePoolMax: number;
  redisUrl: string;
  /** Cloud agent execution (#25). */
  agent: AgentEnv;
  /** Autonomous activity loop (#17). */
  autonomy: AutonomyEnv;
  /** Venture-loop scheduled tick (#96). */
  venture: VentureEnv;
  /** Fleet-watchdog scheduled tick (#105). */
  watchdog: WatchdogEnv;
  /** SRE Loop scheduled tick (#112). */
  sre: SreEnv;
  /** Self-Healing Ops scheduled tick (#193). */
  selfHealing: SelfHealingEnv;
  /** Self-healing flywheel scheduled tick (#117). */
  flywheel: FlywheelEnv;
  /** Self-QA loop scheduled tick (#171). */
  selfqa: SelfqaEnv;
  /** Outcome-verifier scheduled tick (#106). */
  verifiers: VerifiersEnv;
  /** Insight Miner scheduled tick (#100). */
  insight: InsightEnv;
  /** Product Planning Loop scheduled tick (#115). */
  planning: PlanningEnv;
  /** Venture Memory & Planning scheduled weekly tick (#197). */
  ventureMemory: VentureMemoryEnv;
  /** Venture Factory opportunity-scanner scheduled tick (#187). */
  ventureFactory: VentureFactoryEnv;
  /** Autonomous work-cadence scheduled tick (#416). */
  cadence: CadenceEnv;
  /** SkillOpt-Sleep self-improvement nightly tick (#283). */
  skillopt: SkillOptEnv;
  /** Self-Shipping Loop scheduled tick (#172). */
  buildLoop: BuildLoopEnv;
  /** Founder Briefings scheduled tick (#173). */
  briefings: BriefingsEnv;
  /** Content-cadence scheduled tick (#416). */
  contentCadence: ContentCadenceEnv;
  /** Finance Ledger posting/close tick (#194). */
  finance: FinanceEnv;
  /** Venture monetization activation tick (#188). */
  monetization: MonetizationEnv;
  /** Automations scheduled tick (#147). */
  automations: AutomationsEnv;
  /** Workflows scheduled tick (#152). */
  workflows: WorkflowsEnv;
  /** Durable, single-leader scheduler (#559) — how the recurring ticks above are driven. */
  scheduler: SchedulerEnv;
  /** Data retention sweeper (#679): old terminal runs/log tails/artifacts. */
  retention: RetentionEnv;
  /** Human auth session cleanup (#960): expired session hard-delete. */
  authSessionCleanup: AuthSessionCleanupEnv;
  /** Slack-native digest tick (#170). */
  slack: SlackEnv;
  /** Notifications (#8). */
  notify: NotifyEnv;
  /** Apple Messages relay for iMessage-visible agent work. */
  imessage: IMessageEnv;
  /** Approval gates (#13). */
  approval: ApprovalEnv;
  /** Team Mode: parallel multi-agent runs. */
  team: TeamEnv;
  /** Persistent & shared cloud workspaces (#55). */
  cloud: CloudEnv;
  /** Local per-agent git worktree isolation + reaping (#70). */
  git: GitEnv;
  /** Deploy agent-built apps to a live URL (#73). */
  deploy: DeployEnv;
  /** Disaster recovery: backup dump location + drill freshness bound (#99). */
  dr: DrEnv;
  /** Stripe revenue rails (#98). */
  billing: BillingEnv;
  /** Auto model-selection via convene-llm-gateway (Claude-orchestrated). */
  autoModel: AutoModelEnv;
  /** Public dogfood receipt feed (#461). Default off until a deployment opts slugs in. */
  publicDogfood: PublicDogfoodEnv;
}

/**
 * Auto model-selection deployment env (convene-llm-gateway). The **deployment master switch** + the
 * gateway endpoint. Per-tenant on/off lives in the layered config (`autoModel.enabled`), so the owner
 * workspace can be enabled first while everyone else stays on today's behavior.
 *
 * The gateway API KEY is intentionally NOT on this interface: it is read from `process.env.LLM_GATEWAY_KEY`
 * at the HTTP call site and attached as a bearer header only — never persisted, returned, or logged
 * (the same secrets-out-of-logs line the #52 selection + #98 billing rails hold).
 */
export interface AutoModelEnv {
  /** Master switch (`RELOAD_AUTO_MODEL`). Default off ⇒ every launch keeps today's behavior exactly. */
  enabled: boolean;
  /** Gateway base URL (`LLM_GATEWAY_URL`). Absent ⇒ feature off regardless of `enabled` (no network). */
  gatewayUrl?: string;
  /** Request timeout (ms) for the routing call. A slow/unreachable gateway falls back, never blocks. */
  timeoutMs: number;
}

export interface PublicDogfoodEnv {
  /** Comma-separated workspace slugs allowed to expose a public dogfood feed. Empty = disabled. */
  enabledSlugs: string[];
  /** Maximum public receipts returned per feed request. */
  limit: number;
}

/**
 * Durable scheduler deployment env (#559). The recurring engine ticks (planning / venture-memory /
 * verifiers / workflows) run on ONE restart-safe, single-leader scheduler whose state is persisted in
 * `scheduler_jobs`. These knobs tune the leader lease + poll cadence + failure backoff; the per-job cadence
 * still comes from each engine's own `*_INTERVAL_MS` (default 0 = off), so nothing autonomous runs until a
 * deployment opts a job in.
 */
export interface SchedulerEnv {
  /** This replica's lease-holder id (`SCHEDULER_INSTANCE_ID`). Defaults to `<hostname>:<pid>`. */
  instanceId: string;
  /** How long a claimed lease is held before it auto-expires (`SCHEDULER_LEASE_MS`). Default 60s. */
  leaseMs: number;
  /** How often the single poll loop fires (`SCHEDULER_POLL_MS`). Default 5s. */
  pollIntervalMs: number;
  /** Per-tick wall-clock bound (`SCHEDULER_JOB_TIMEOUT_MS`) — a wedged tick is abandoned. Default 5m. */
  jobTimeoutMs: number;
  /** First backoff delay after a failing tick (`SCHEDULER_BACKOFF_BASE_MS`). Default 1s. */
  backoffBaseMs: number;
  /** Backoff ceiling (`SCHEDULER_BACKOFF_CAP_MS`) — bounds the retry cadence so it can never hang. Default 60s. */
  backoffCapMs: number;
}

export interface RetentionEnv {
  /** Terminal run retention in days. 0 disables pruning. */
  runRetentionDays: number;
  /** How often to sweep old run data. 0 disables the automatic loop. */
  intervalMs: number;
  /** Max terminal sessions to delete per sweep. */
  batchSize: number;
}

export interface AuthSessionCleanupEnv {
  /** How often to delete expired human auth sessions. Default 1h. */
  intervalMs: number;
  /** Max expired sessions to delete per sweep. */
  batchSize: number;
}

export interface DrEnv {
  /**
   * Local directory used as the dryrun-by-default object store for dumps (the validation drill + the
   * honest local/compose fallback). Real off-site upload is done by the backup workflow's `aws` CLI
   * against an S3-compatible bucket — this local dir is never the production backup. Default `.dr-backups`.
   */
  localDir: string;
  /** Object-key prefix dumps are stored under. Default `dumps/`. */
  dumpPrefix: string;
  /** Maximum tolerated age of the latest dump before a restore pre-flight aborts. Default 24h. */
  maxDumpAgeMs: number;
}

/** Which revenue backend collects payment (#98). */
export type BillingProviderKind = "none" | "stripe";

export interface BillingEnv {
  /**
   * The billing backend. Default `none` (no network — a no-spend stand-in) so tests/CI/the demo run
   * free. `stripe` enables the real adapter (its SDK is loaded lazily on first call). Per-tenant policy
   * (currency, secret-var names) lives in the layered config (#58), not here.
   */
  provider: BillingProviderKind;
  /**
   * Go-live intent (#481). `test` (the default everywhere) never moves real money; `live` does. Going
   * live is the owner's explicit three-part flip: `BILLING_PROVIDER=stripe` + `BILLING_MODE=live` + a real
   * `sk_live_…` key. The Stripe adapter fails closed if the key's prefix contradicts this mode.
   */
  mode: BillingMode;
  /**
   * Max accepted age (seconds) of a webhook signature timestamp — the replay window. Default 300
   * (Stripe's recommendation).
   */
  webhookToleranceSeconds: number;
}

export interface GitEnv {
  /**
   * Periodic worktree-reaper interval in ms. Default `0` = the background sweep is OFF (opt-in),
   * mirroring the #17 autonomy loop and #55 cloud sweep. A single sweep always runs on startup
   * regardless; this only governs the recurring timer. Has effect only when `GIT_WORKSPACE_REPO`
   * is configured (no repo → no worktrees → no reaper).
   */
  reapIntervalMs: number;
}

/** Which managed-hosting backend deploys agent-built apps (#73). */
export type DeployProviderKind = "dryrun" | "vercel";

export interface DeployEnv {
  /**
   * The deploy backend. Default `dryrun` (no cloud spend — a deterministic fake URL) so tests/CI/the
   * demo run free. `vercel` enables the real adapter (its SDK is loaded lazily on first deploy).
   */
  provider: DeployProviderKind;
  /**
   * Health-monitor interval in ms. Default `0` = the background sweep is OFF (opt-in), mirroring the
   * #17 autonomy loop / #55 cloud sweep — tests drive `checkHealth()` deterministically.
   */
  monitorIntervalMs: number;
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

export interface VentureEnv {
  /** Venture-tick interval in ms. Default `0` = the background tick is OFF (opt-in, #96). */
  intervalMs: number;
}

export interface WatchdogEnv {
  /** Watchdog-tick interval in ms. Default `0` = the background supervisor is OFF (opt-in, #105). */
  intervalMs: number;
}

export interface SreEnv {
  /** SRE-tick interval in ms. Default `0` = the background on-call loop is OFF (opt-in, #112). */
  intervalMs: number;
}

export interface SelfHealingEnv {
  /** Self-healing tick interval in ms. Default `0` = the loop is OFF (opt-in, #193). */
  intervalMs: number;
}

export interface FlywheelEnv {
  /** Flywheel-tick interval in ms. Default `0` = the background loop is OFF (opt-in, #117). */
  intervalMs: number;
}

export interface SelfqaEnv {
  /** Self-QA tick interval in ms. Default `0` = the background loop is OFF (opt-in, #171). */
  intervalMs: number;
  /** The live product URL the synthetic user drives. Default the public web console. */
  target: string;
  /** The headless driver: `none` (default no-op), `http` (smoke), or `playwright` (lazy, opt-in). */
  driver: string;
}

export interface VerifiersEnv {
  /** Verifier-tick interval in ms. Default `0` = the background runner is OFF (opt-in, #106). */
  intervalMs: number;
}

export interface InsightEnv {
  /** Insight-mining tick interval in ms. Default `0` = the background loop is OFF (opt-in, #100). */
  intervalMs: number;
}

export interface PlanningEnv {
  /** Planning-tick interval in ms. Default `0` = the background loop is OFF (opt-in, #115). */
  intervalMs: number;
}

export interface VentureMemoryEnv {
  /** Weekly-planning-tick interval in ms. Default `0` = the background loop is OFF (opt-in, #197). */
  intervalMs: number;
}

export interface VentureFactoryEnv {
  /** Venture-factory scanner-tick interval in ms. Default `0` = the background loop is OFF (opt-in, #187). */
  intervalMs: number;
}

export interface CadenceEnv {
  /** Work-cadence tick interval in ms. Default `0` = the background loop is OFF (opt-in, #416). */
  intervalMs: number;
}

export interface SkillOptEnv {
  /** SkillOpt-Sleep nightly tick interval in ms. Default `0` = the self-improvement loop is OFF (opt-in, #283). */
  intervalMs: number;
}

export interface BuildLoopEnv {
  /** Self-shipping-tick interval in ms. Default `0` = the background loop is OFF (opt-in, #172). */
  intervalMs: number;
}

export interface BriefingsEnv {
  /** Briefings-tick interval in ms. Default `0` = the background reporting loop is OFF (opt-in, #173). */
  intervalMs: number;
}

export interface ContentCadenceEnv {
  /** Content-cadence tick interval in ms. Default `0` = the loop is OFF (opt-in, #416). */
  intervalMs: number;
}

export interface FinanceEnv {
  /** Finance posting/close-tick interval in ms. Default `0` = the accounting loop is OFF (opt-in, #194). */
  intervalMs: number;
}

export interface MonetizationEnv {
  /** Monetization activation-tick interval in ms. Default `0` = the minting loop is OFF (opt-in, #188). */
  intervalMs: number;
}

export interface AutomationsEnv {
  /** Automations-tick interval in ms. Default `0` = the background loop is OFF (opt-in, #147). */
  intervalMs: number;
}

export interface WorkflowsEnv {
  /** Workflows-tick interval in ms. Default `0` = the background loop is OFF (opt-in, #152). */
  intervalMs: number;
}

export interface SlackEnv {
  /** Slack-digest-tick interval in ms. Default `0` = the background DM loop is OFF (opt-in, #170). */
  intervalMs: number;
}

export interface NotifyEnv {
  /** External transport: when set, notifications are POSTed here; unset → no-op transport. */
  webhookUrl?: string;
}

export interface IMessageEnv {
  /** Master switch. Default off so production never texts without explicit operator intent. */
  enabled: boolean;
  /** The owner/test recipient that receives agent-work messages through Apple Messages. */
  recipient?: string;
  /** Optional Messages service name; blank uses the first iMessage service. */
  serviceName?: string;
  /** Path/name for osascript. */
  osascriptBin: string;
  /** When true, validate + record intent without sending through Messages. */
  dryRun: boolean;
  /** Message length guardrail before handing text to Messages. */
  maxChars: number;
}

export interface ApprovalEnv {
  /** Default TTL (seconds) after which an undecided request expires. Override per request. */
  defaultTtlSeconds: number;
  /** Approval-expiry sweep interval in ms. Default 0 disables the background timer. */
  sweepIntervalMs: number;
}

export interface AgentEnv {
  /**
   * Posture profile (#69): the named preset that sets the runtime/harness defaults. `dev` =
   * local/demo (the default), `prod` = sandbox/claude-code. Reported for the preflight/doctor.
   */
  profile: ProfileName;
  /** Execution backend. Default `local` so tests/CI need no cloud spend. */
  runtime: RuntimeKind;
  /** Which coding-agent harness runs each session (#50). Default `demo` (no model spend). */
  harness: HarnessKind;
  /** The trusted harness command + args run for each session (NOT client-supplied). */
  harnessCommand: string;
  harnessArgs: string[];
  /** Hard per-session resource + wall-clock caps. */
  caps: ResourceCaps;
  /**
   * Optional repo cloned into each sandbox session (#83, Conductor "agent on an isolated branch").
   * Resolved from `SANDBOX_REPO_URL`/`SANDBOX_REPO_REVISION`; undefined → an empty sandbox. Read by
   * the sandbox backend only — `local`/`demo` (the default) ignores it.
   */
  sandboxSource?: SandboxGitSource;
}

function parseRuntime(value: string | undefined): RuntimeKind {
  return value === "sandbox" ? "sandbox" : "local";
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseHarnessArgs(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string")) {
      throw new Error("must be a JSON array of strings");
    }
    return parsed;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid JSON";
    throw new ConfigValidationError(
      "env",
      `AGENT_HARNESS_ARGS must be a JSON array of strings (${detail})`,
    );
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return {
    port: Number(source.PORT ?? 3000),
    databaseUrl: source.DATABASE_URL ?? "postgres://reload:reload@localhost:5433/reload",
    // #113 worker-concurrency knob: pg pool size per process. Default 10 (the prior hard-coded value).
    databasePoolMax: num(source.DATABASE_POOL_MAX, 10),
    redisUrl: source.REDIS_URL ?? "redis://localhost:6379",
    publicDogfood: {
      enabledSlugs: list(source.PUBLIC_DOGFOOD_SLUGS),
      limit: num(source.PUBLIC_DOGFOOD_LIMIT, 30),
    },
    agent: (() => {
      // Posture profile (#69): pick a named preset (dev=local/demo, prod=sandbox/claude-code) that
      // supplies the runtime/harness DEFAULTS. Precedence is explicit env > profile preset > built-in
      // default, so the default profile `dev` resolves to local/demo exactly as before — additive.
      const profile = parseProfile(source.RELOAD_PROFILE);
      const preset = profilePreset(profile);
      // Select the coding-agent harness (#50). Default `demo` keeps tests/CI free of model spend;
      // `claude-code` runs the real Claude Code CLI. Explicit AGENT_HARNESS_CMD/ARGS still override.
      const harness = parseHarnessKind(source.AGENT_HARNESS ?? preset.harness);
      // Model/provider selection (#52) flows through env Claude Code reads natively (ANTHROPIC_MODEL
      // + provider flags), delivered per-session via the harnessEnv seam — so we no longer bake a
      // static `--model` here. A deployment-wide default ANTHROPIC_MODEL in the process env still
      // applies (the harness emits an env-gated `--model "$ANTHROPIC_MODEL"`); per-session selection
      // overrides it.
      const spec = harnessSpec(harness, {
        claudeBin: source.CLAUDE_BIN,
        codexBin: source.CODEX_BIN,
      });
      // #83: a repo to clone into each sandbox session (agent-on-a-branch). Previously only the
      // smoke script read these; now the server threads it into provider.create via the factory.
      const repoUrl = source.SANDBOX_REPO_URL?.trim();
      const repoRevision = source.SANDBOX_REPO_REVISION?.trim();
      const sandboxSource: SandboxGitSource | undefined = repoUrl
        ? { url: repoUrl, ...(repoRevision ? { revision: repoRevision } : {}) }
        : undefined;
      return {
        profile,
        runtime: parseRuntime(source.AGENT_RUNTIME ?? preset.runtime),
        harness,
        harnessCommand: source.AGENT_HARNESS_CMD ?? spec.command,
        harnessArgs: parseHarnessArgs(source.AGENT_HARNESS_ARGS, spec.args),
        caps: {
          wallClockMs: num(source.AGENT_WALLCLOCK_MS, 600_000),
          // #394: 120s idle was reaping THINKING agents mid-reason (a long Opus reasoning pass emits no
          // output for minutes), a major source of the ~40% fail/hang rate. Raised to 300s; the 10-min
          // wall-clock still backstops a truly dead run. Override per-deploy with AGENT_IDLE_MS.
          idleMs: num(source.AGENT_IDLE_MS, 300_000),
          memoryMb: source.AGENT_MEMORY_MB ? num(source.AGENT_MEMORY_MB, 512) : undefined,
        },
        sandboxSource,
      };
    })(),
    venture: {
      intervalMs: Number(source.VENTURE_INTERVAL_MS ?? 0) || 0,
    },
    watchdog: {
      // Default 0 (off): the supervisor timer is opt-in so tests/CI drive `tickAll()` deterministically.
      intervalMs: Number(source.WATCHDOG_INTERVAL_MS ?? 0) || 0,
    },
    sre: {
      // Default 0 (off): the on-call loop timer is opt-in so tests/CI drive `tickAll()` deterministically.
      intervalMs: Number(source.SRE_INTERVAL_MS ?? 0) || 0,
    },
    selfHealing: {
      // Default 0 (off): the self-healing loop timer is opt-in so tests/CI drive `tickAll()` deterministically.
      intervalMs: Number(source.SELF_HEALING_INTERVAL_MS ?? 0) || 0,
    },
    flywheel: {
      // Default 0 (off): the flywheel loop is opt-in so tests/CI drive `tickAll()` deterministically.
      intervalMs: Number(source.FLYWHEEL_INTERVAL_MS ?? 0) || 0,
    },
    selfqa: {
      // Default 0 (off): the self-QA loop is opt-in. The always-on entry is the CI CLI (#171), not the timer.
      intervalMs: Number(source.SELFQA_INTERVAL_MS ?? 0) || 0,
      target: source.SELFQA_TARGET ?? "https://ipop.ai",
      driver: source.SELFQA_DRIVER ?? "none",
    },
    verifiers: {
      // Default 0 (off): the verifier runner is opt-in so tests/CI drive `tickWorkspace()` deterministically.
      intervalMs: Number(source.VERIFIERS_INTERVAL_MS ?? 0) || 0,
    },
    insight: {
      // Default 0 (off): the insight-mining loop is opt-in so tests/CI drive `mine()` deterministically.
      intervalMs: Number(source.INSIGHT_INTERVAL_MS ?? 0) || 0,
    },
    planning: {
      // Default 0 (off): the planning loop is opt-in so tests/CI drive `tick()` deterministically.
      intervalMs: Number(source.PLANNING_INTERVAL_MS ?? 0) || 0,
    },
    ventureMemory: {
      // Default 0 (off): the weekly planning loop is opt-in so tests/CI drive `tick()` deterministically.
      intervalMs: Number(source.VENTURE_PLANNING_INTERVAL_MS ?? 0) || 0,
    },
    ventureFactory: {
      // Default 0 (off): the opportunity-scanner loop is opt-in so tests/CI drive `advanceWorkspace()` deterministically.
      intervalMs: Number(source.VENTURE_FACTORY_INTERVAL_MS ?? 0) || 0,
    },
    cadence: {
      // Default 0 (off): the autonomous work-cadence loop is opt-in so tests/CI drive `tickAll()` deterministically.
      intervalMs: Number(source.RELOAD_CADENCE_INTERVAL_MS ?? 0) || 0,
    },
    skillopt: {
      // Default 0 (off): the SkillOpt-Sleep self-improvement loop is opt-in so tests/CI drive `tickAll()`
      // deterministically and prod is unchanged until the owner flips it on (#283).
      intervalMs: Number(source.RELOAD_SKILLOPT_INTERVAL_MS ?? 0) || 0,
    },
    buildLoop: {
      // Default 0 (off): the self-shipping loop is opt-in so tests/CI drive `tickWorkspace()` deterministically.
      intervalMs: Number(source.BUILDLOOP_INTERVAL_MS ?? 0) || 0,
    },
    briefings: {
      // Default 0 (off): the briefings loop is opt-in so tests/CI drive `tickWorkspace()` deterministically.
      intervalMs: Number(source.BRIEFINGS_INTERVAL_MS ?? 0) || 0,
    },
    contentCadence: {
      // Default 0 (off): the content-cadence loop is opt-in so prod is unchanged until the owner flips it (#416).
      intervalMs: Number(source.CONTENT_CADENCE_INTERVAL_MS ?? 0) || 0,
    },
    finance: {
      // Default 0 (off): the finance ledger loop is opt-in so tests/CI drive `tickWorkspace()` deterministically.
      intervalMs: Number(source.FINANCE_INTERVAL_MS ?? 0) || 0,
    },
    monetization: {
      // Default 0 (off): the monetization activation loop is opt-in so tests/CI drive `tickWorkspace()` deterministically.
      intervalMs: Number(source.MONETIZATION_INTERVAL_MS ?? 0) || 0,
    },
    automations: {
      // Default 0 (off): the automations loop is opt-in so tests/CI drive `tickAll()` deterministically.
      intervalMs: Number(source.AUTOMATIONS_INTERVAL_MS ?? 0) || 0,
    },
    workflows: {
      // Default 0 (off): the workflows loop is opt-in so tests/CI drive `tickAll()` deterministically.
      intervalMs: Number(source.WORKFLOWS_INTERVAL_MS ?? 0) || 0,
    },
    scheduler: {
      // #559: the leader lease + poll cadence + bounded backoff for the durable scheduler that drives the
      // recurring engine ticks. The per-job cadence still comes from each engine's own *_INTERVAL_MS.
      instanceId: source.SCHEDULER_INSTANCE_ID || `${hostname()}:${process.pid}`,
      leaseMs: num(source.SCHEDULER_LEASE_MS, 60_000),
      pollIntervalMs: num(source.SCHEDULER_POLL_MS, 5_000),
      jobTimeoutMs: num(source.SCHEDULER_JOB_TIMEOUT_MS, 300_000),
      backoffBaseMs: num(source.SCHEDULER_BACKOFF_BASE_MS, 1_000),
      backoffCapMs: num(source.SCHEDULER_BACKOFF_CAP_MS, 60_000),
    },
    retention: {
      runRetentionDays: num(source.RELOAD_RUN_RETENTION_DAYS, 30),
      // Default 0 (off): the retention loop is opt-in so tests/CI can call sweepRetention() deterministically.
      intervalMs: Number(source.RELOAD_RETENTION_INTERVAL_MS ?? 0) || 0,
      batchSize: num(source.RELOAD_RETENTION_BATCH_SIZE, 500),
    },
    authSessionCleanup: {
      intervalMs: Number(source.AUTH_SESSION_CLEANUP_INTERVAL_MS ?? 3_600_000) || 0,
      batchSize: num(source.AUTH_SESSION_CLEANUP_BATCH_SIZE, 1_000),
    },
    slack: {
      // Default 0 (off): the Slack digest loop is opt-in so tests/CI drive `tickWorkspace()` deterministically.
      intervalMs: Number(source.SLACK_DIGEST_INTERVAL_MS ?? 0) || 0,
    },
    autonomy: {
      // Default 0 (off): the background loop is opt-in so tests/CI drive `tick()` deterministically.
      intervalMs: Number(source.AUTONOMY_INTERVAL_MS ?? 0) || 0,
    },
    notify: {
      webhookUrl: source.NOTIFY_WEBHOOK_URL || undefined,
    },
    imessage: {
      enabled: source.IMESSAGE_RELAY_ENABLED === "true" || source.IMESSAGE_RELAY_ENABLED === "1",
      recipient: source.IMESSAGE_RELAY_RECIPIENT || undefined,
      serviceName: source.IMESSAGE_RELAY_SERVICE || undefined,
      osascriptBin: source.IMESSAGE_OSASCRIPT_BIN || "osascript",
      dryRun: source.IMESSAGE_RELAY_DRY_RUN === "true" || source.IMESSAGE_RELAY_DRY_RUN === "1",
      maxChars: num(source.IMESSAGE_RELAY_MAX_CHARS, 1800),
    },
    approval: {
      defaultTtlSeconds: num(source.APPROVAL_TTL_SECONDS, 86_400),
      sweepIntervalMs: Number(source.APPROVAL_SWEEP_INTERVAL_MS ?? 0) || 0,
    },
    team: {
      maxConcurrency: num(source.TEAM_MAX_CONCURRENCY, 3),
    },
    cloud: {
      // Default 0 (off): the idle sweep is opt-in so tests/CI drive `sweepIdle()` deterministically.
      sweepIntervalMs: Number(source.CLOUD_SWEEP_INTERVAL_MS ?? 0) || 0,
      idleMs: num(source.CLOUD_IDLE_MS, 1_800_000),
    },
    git: {
      // Default 0 (off): the periodic worktree reaper is opt-in; a single startup sweep always runs.
      reapIntervalMs: Number(source.GIT_WORKTREE_REAP_INTERVAL_MS ?? 0) || 0,
    },
    deploy: {
      // Default `dryrun`: no cloud spend. `vercel` enables the real adapter (lazy SDK load).
      provider: source.DEPLOY_PROVIDER === "vercel" ? "vercel" : "dryrun",
      // Default 0 (off): the health sweep is opt-in so tests/CI drive `checkHealth()` deterministically.
      monitorIntervalMs: Number(source.DEPLOY_MONITOR_INTERVAL_MS ?? 0) || 0,
    },
    dr: {
      localDir: source.DR_LOCAL_DIR ?? ".dr-backups",
      dumpPrefix: source.DR_DUMP_PREFIX ?? "dumps/",
      maxDumpAgeMs: num(source.DR_MAX_DUMP_AGE_MS, 86_400_000),
    },
    billing: {
      // Default `none`: no network/spend. `stripe` enables the real adapter (lazy SDK load).
      provider: source.BILLING_PROVIDER === "stripe" ? "stripe" : "none",
      // #481 go-live: only the exact string `live` takes real money — anything else is `test` (fail safe).
      mode: source.BILLING_MODE === "live" ? "live" : "test",
      // Stripe's recommended webhook replay window (seconds).
      webhookToleranceSeconds: num(source.BILLING_WEBHOOK_TOLERANCE_SECONDS, 300),
    },
    autoModel: {
      // Default off (master switch). Even when on, an absent LLM_GATEWAY_URL keeps the feature off
      // (no network) and per-tenant `autoModel.enabled` config gates which workspaces actually route.
      enabled: source.RELOAD_AUTO_MODEL === "true" || source.RELOAD_AUTO_MODEL === "1",
      gatewayUrl: source.LLM_GATEWAY_URL || undefined,
      timeoutMs: num(source.LLM_GATEWAY_TIMEOUT_MS, 4_000),
    },
  };
}
