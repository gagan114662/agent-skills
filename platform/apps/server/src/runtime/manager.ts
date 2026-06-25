import type {
  AgentSession,
  EffortLevel,
  ProviderKind,
  ResourceCaps,
  RuntimeKind,
  SessionMode,
  SessionStatus,
} from "../db/repositories/agent-sessions.js";
import {
  recordSessionEnded,
  recordSessionStarted,
  recordSessionRetry,
  observeSpinup,
} from "../observability/metrics.js";
import { makeRedactor, redactPotentialSecrets } from "./redact.js";
import { decideSessionRetry } from "./session-retry.js";
import type { BackoffPolicy } from "../durable-workflow/types.js";
import {
  harnessEventReportsError,
  finalAnswerFromEvent,
  toolCallFromEvent,
  errorMessageFromEvent,
  type HarnessToolCall,
  type LineDecoder,
} from "./stream-json.js";
import { isHarnessKind, type HarnessKind, type HarnessSpec } from "./harness.js";
import { PreflightError, type PreflightReport } from "./preflight.js";
import type { SecretsResolver } from "./secrets-resolver.js";
import { resolveEgressPolicy } from "./egress-allowlist.js";
import { loadConfig } from "../config/loader.js";
import type { WorkspaceProvisioner } from "../config/workspace.js";
import type { AdmissionController, AdmissionTicket } from "../scale/admission.js";
import type { SpendAnomalyMonitor, SpendGuardSession } from "../scale/spend-anomaly.js";
import type { DecideSpendInput, SpendOutcome } from "../enterprise/service.js";
import type { UsageRecorder } from "../scale/usage.js";
import type { AgentRuntime, RunningSession, RuntimeResult } from "./types.js";
import { statusForReason } from "./types.js";
import type { AutoModelDecision, AutoModelResolver } from "./auto-model.js";
import {
  renderSessionOutcome,
  classifyFailure,
  failureCopy,
  isSuccess,
  decideSessionDisposition,
  type FailureReasonClass,
} from "./outcome.js";
import { resolveLaunchModel } from "./models.js";
import {
  noopTracer,
  type AgentSessionOutcome,
  type AgentTracer,
} from "../observability/tracing.js";

/**
 * Thrown when a per-session harness selection is invalid (not in the allowlist) or cannot be honored
 * (no override resolver wired). Content-free + safe to surface as an HTTP 400 — never names a secret.
 */
export class HarnessKindError extends Error {
  constructor(value: unknown, detail = "is not a recognized harness") {
    super(`harness ${JSON.stringify(value)} ${detail}`);
    this.name = "HarnessKindError";
  }
}

/** Thrown before session creation when enterprise hard budget caps park an owner approval (#925). */
export class SpendCapBreachError extends Error {
  readonly reason = "enterprise_budget_cap_breached";

  constructor(
    readonly approvalRequestId: string,
    readonly requestCents: number,
    message: string,
  ) {
    super(message);
    this.name = "SpendCapBreachError";
  }
}

/** Persistence seam (real impl wraps the agent-sessions repository; tests inject a fake). */
export interface SessionStore {
  create(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    runtime: RuntimeKind;
    command: string;
    /** Optional caller-owned idempotency key; duplicate launches return the existing session row. */
    idempotencyKey?: string | null;
    caps: ResourceCaps;
    /** Coding-agent harness the session ran on (#50); omitted → null (env default unselected). */
    harness?: HarnessKind | null;
    /** Non-secret model/provider selection (#52); omitted when no explicit selection was made. */
    provider?: ProviderKind | null;
    model?: string | null;
    effort?: EffortLevel | null;
    mode?: SessionMode | null;
    /** Auto model-selection "why?" record (convene-llm-gateway); omitted when not auto-selected. */
    selectionMeta?: AutoModelDecision | null;
    /** Multi-region placement (#71): the region the session was placed in (null when unplaced). */
    region?: string | null;
  }): Promise<AgentSession>;
  markRunning(id: string, sandboxId?: string): Promise<void>;
  /**
   * Bump the session's liveness heartbeat (#105). Called on every output chunk — the same signal the
   * idle-reaper trusts as proof of progress — so the Fleet Watchdog can detect a session whose driving
   * process died (a network blip) cross-process. **Optional** so every existing fake store still
   * satisfies the seam; absent ⇒ no heartbeat (today's behavior). A heartbeat hiccup never fails a run.
   */
  heartbeat?(id: string): Promise<void>;
  finalize(
    id: string,
    fields: {
      status: SessionStatus;
      exitCode?: number | null;
      result?: string | null;
      snapshotId?: string | null;
    },
  ): Promise<void>;
  /**
   * Force a session to a terminal state ONLY if it is still live (#248) — used by {@link
   * SessionManager.cancel} to kill a session this process is no longer driving (an orphan left
   * `running` by a deploy/restart, or one started on another machine) and by the pre-start vanish
   * defense. Returns whether a live row was finalized (`false` ⇒ already terminal / unknown, so a
   * concurrent finalize is never stomped). **Optional** so every existing fake store still satisfies
   * the seam; absent ⇒ the manager can only cancel sessions it is actively driving (today's behavior).
   */
  forceFinalize?(
    id: string,
    fields: { status: SessionStatus; result?: string | null; exitCode?: number | null },
  ): Promise<boolean>;
}

/** Channel delivery seam (real impl persists + publishes a message; tests inject a fake). */
export interface ChannelPoster {
  post(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    body: string;
    parentMessageId?: string;
  }): Promise<{ id: string }>;
}

export interface EnterpriseSpendGate {
  decideSpend(input: DecideSpendInput): Promise<SpendOutcome>;
}

/** Minimal structural logger — Fastify's pino `app.log` satisfies this; tests pass a no-op. */
export interface SessionLogger {
  child(bindings: Record<string, unknown>): SessionLogger;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface SessionManagerDeps {
  runtime: AgentRuntime;
  store: SessionStore;
  poster: ChannelPoster;
  secrets: SecretsResolver;
  /** The trusted DEFAULT harness command run for a session (never client-supplied). */
  harness: { command: string; args: string[] };
  /**
   * The kind of {@link harness} — the deployment/env default (#50). Persisted on a session row when
   * no per-session override is given. Defaults to `demo` when unset (back-compat for callers that
   * only wired the legacy `{ command, args }`).
   */
  harnessKind?: HarnessKind;
  /**
   * Per-session harness override resolver (#50): maps an allowlisted {@link HarnessKind} to its
   * trusted spec + output decoder. Wired in production from `harnessSpec` + `harnessLineDecoder`.
   * When absent, a launch may only use the default kind — a differing override is rejected (the
   * manager cannot synthesize a spec for a kind it was not given a resolver for). Always pure: it
   * never takes the task (which is injected as env), so a per-session harness adds no injection
   * surface, and the runtime backend (Local/Sandbox) honors the resolved spec identically.
   */
  harnessOverrides?: (
    kind: HarnessKind,
    opts?: { fast?: boolean },
  ) => { command: string; args: string[]; decode: LineDecoder };
  caps: ResourceCaps;
  logger: SessionLogger;
  /**
   * #436: bounded inline retry budget for a transient, PRE-PROGRESS session death — covers BOTH a
   * `runtime.start()` throw (no process ran) AND a process that started then died returning a `null`
   * exit code with **no output and no heartbeat** (so no real/money action could have landed — safe to
   * re-run per #200 §4). `<= 1` (default) ⇒ a single attempt, no retry (today's behavior); `2`+ re-attempts
   * the full start→wait cycle that many times with exponential backoff. The instant any output/heartbeat is
   * seen the attempt is never retried (it may have acted) — it fails honestly and routes to self-healing.
   */
  sessionRetryMaxAttempts?: number;
  /**
   * Deprecated alias for {@link sessionRetryMaxAttempts}, retained for the original #435 narrow
   * spawn-launch knob (`AGENT_SPAWN_RETRY_MAX_ATTEMPTS`). When both are set, `sessionRetryMaxAttempts`
   * wins; otherwise this value still drives the (now broader, still idempotency-safe) retry budget.
   */
  spawnRetryMaxAttempts?: number;
  /**
   * #436: backoff schedule between retry attempts. Absent ⇒ the conservative default (exp from 1s,
   * factor 3, capped at 10s). Injected mainly so tests can drive a near-instant schedule deterministically.
   */
  sessionRetryBackoff?: BackoffPolicy;
  /**
   * #394: the grace window (ms) the run loop gives `RunningSession.cancel()` to tear down cleanly
   * after a reaper (idle / wall-clock) fires before it finalizes the run WITHOUT waiting on the
   * runtime. The reaper relies on `wait()` resolving, but a wedged teardown (e.g. a sandbox
   * `snapshot()`/`stop()` cloud call that hangs) leaves BOTH `wait()` and `cancel()` stuck, so the
   * loop would block on `await running.wait()` forever and the row would stay `running` until only
   * the cross-process fleet watchdog reaps it ("the run hung"). Racing `wait()` against this bounded
   * deadline guarantees every reaped run reaches `finalize()` in bounded time. Absent ⇒
   * {@link DEFAULT_REAP_GRACE_MS}; tests inject a tiny value to exercise the path without real delay.
   */
  reapGraceMs?: number;
  /** Optional observability seam: traces each session as a span. Defaults to a no-op. */
  tracer?: AgentTracer;
  /**
   * Optional preflight gate (#69): validates the deployment's posture (cloud auth + harness
   * availability) before a launch persists or touches the runtime. When `!ok`, `launch()` throws a
   * {@link PreflightError} before any cloud call. Absent → no gate (today's behavior); the default
   * `local`/`demo` posture always passes, so wiring it in production changes nothing for that path.
   */
  preflight?: () => PreflightReport;
  /**
   * Optional workspace seam (#58): prepares a per-session working dir + copies files-to-copy into
   * it before the runtime starts. When absent, the harness inherits the server cwd (#25 behavior).
   */
  workspace?: WorkspaceProvisioner;
  /**
   * Cloud-scale admission (#71): the launch chokepoint — kill switch (#17), per-tenant budget, and
   * per-tenant + global concurrency caps, plus region placement. When absent, every launch is
   * admitted and unplaced (today's #25 behavior). A denied launch makes `launch` throw before any
   * row is created.
   */
  admission?: AdmissionController;
  /**
   * Cloud-scale usage accounting (#71): records an admitted launch + its compute-seconds so a
   * per-tenant budget can bite. Absent → no accounting (today's behavior).
   */
  usage?: UsageRecorder;
  /**
   * Runtime spend anomaly guard (#926): estimates in-flight session cost, emits threshold alerts, and
   * asks the manager to cancel a runaway session before it drains the workspace budget. Absent means no
   * realtime spend guard; finalized usage accounting still runs through usage.
   */
  spendAnomaly?: SpendAnomalyMonitor;
  /** Poll cadence for the spend anomaly guard. Prod defaults conservatively; tests inject a tiny value. */
  spendAnomalyIntervalMs?: number;
  /**
   * Enterprise hard budget caps (#925): preflight a session's upper-bound compute cost before admission,
   * row creation, or runtime start. Absent/default rate 0 keeps existing behavior unchanged.
   */
  enterprise?: EnterpriseSpendGate;
  enterpriseComputeRateCentsPerMinute?: (workspaceId: string) => number;
  /**
   * Optional harness-aware output decoder (#81): converts each raw stdout line into readable channel
   * text, keeping the parsed event for structured consumers. The `claude-code` harness emits
   * stream-json (one JSON event per line), so without this the channel shows raw JSON blobs. Absent
   * (and for the `demo` harness) → a verbatim pass-through, so default output is unchanged.
   */
  decodeOutput?: LineDecoder;
  /**
   * Auto model-selection (convene-llm-gateway). When wired AND enabled for the tenant, a launch that
   * pins **no** explicit model asks the routing layer for the best model — Claude orchestrates +
   * validates + escalates to the chosen tier; the decision lands on the session row as the owner's
   * "why?" audit. Absent (the default) ⇒ no auto-selection: every launch keeps today's behavior. The
   * resolver never throws — a gateway failure degrades to the deployment default, never blocks a launch.
   * Wired centrally HERE (not at the REST route) so @mention/autonomy/marketing launches are covered too.
   */
  autoModel?: AutoModelResolver;
  /**
   * Per-agent model override (#662): a persona-specific model, read at launch and applied after an
   * explicit per-session pin but before the workspace/default model. Absent/null means the workspace
   * fallback chain wins.
   */
  modelForAgent?: (workspaceId: string, agentMemberId: string) => Promise<string | null>;
  /**
   * Model preflight (#246): the workspace's owner-picked fleet model, read at launch. When set (and no
   * per-session #52 model is pinned), it is injected as the session's `ANTHROPIC_MODEL`, overriding the
   * deployment default. Together with {@link envDefaultModel} it lets the launch gate validate the
   * EFFECTIVE model against the models known to resolve BEFORE spawning a real `claude-code` session —
   * so an unservable id (the `claude-fable-5` class) throws an actionable {@link ModelUnavailableError}
   * instead of crashing mid-run. Absent ⇒ no per-workspace model + no gate (today's behavior); the
   * deployment `ANTHROPIC_MODEL` still applies via the harness's env-gated `--model` flag.
   */
  modelForWorkspace?: (workspaceId: string) => Promise<string | null>;
  /**
   * The deployment-wide default model (`ANTHROPIC_MODEL`) the gate validates when a workspace pins none.
   * Wired from env in production. Absent ⇒ the gate falls back to the canonical default. Only consulted
   * when {@link modelForWorkspace} is wired (the #246 production path).
   */
  envDefaultModel?: string;
  /**
   * Optional failure sink (#230): called best-effort when a session ends in a genuine failure
   * (spawn-and-die / harness crash / timeout) so the failure is ROUTED to self-healing/escalation
   * (#117 flywheel) instead of silently dying — the #166/#230 gap where 21 sessions failed and nothing
   * surfaced. Never called for a clean completion, an auth/budget stop (the owner must act, a fix agent
   * can't), or a cancel. Absent → no routing (today's behavior); a sink error never affects the session.
   */
  onSessionFailure?(event: {
    workspaceId: string;
    sessionId: string;
    channelId: string;
    agentMemberId: string;
    status: SessionStatus;
    exitCode: number | null;
    failureClass: FailureReasonClass;
    /** Brand-voice headline (no raw output) — the fingerprint message. */
    message: string;
    /**
     * A short, already-redacted excerpt of the real terminal output (#242) — so the surfaced incident /
     * flywheel record names the ACTUAL cause (e.g. the unavailable model) instead of only the generic
     * headline ("error · exit 1"). Bounded + redacted upstream; may be empty when the run produced no tail.
     */
    errorExcerpt?: string;
  }): Promise<void>;
  /**
   * Optional recovery sink (#238): called best-effort when a session COMPLETES cleanly — the
   * production-grounded proof the runtime is healthy again. Wired in production to resolve an open
   * agent-runtime spawn incident (#193) so a self-healing incident opened by a spawn cluster closes
   * itself once real sessions succeed (e.g. after the image is patched/redeployed). Absent → no-op; a
   * sink error never affects the already-finalized session.
   */
  onSessionRecovered?(event: { workspaceId: string; sessionId: string }): Promise<void>;
  /**
   * Optional completion sink (#248): called best-effort when a session COMPLETES cleanly with real
   * output — so a briefed deliverable (the actual draft) is SURFACED as a board artifact (the #13
   * APPROVAL NEEDED queue) instead of living only as a channel message + `agent_sessions.result` row
   * the owner never sees (the "vanished" bug). Fires ONLY when the launch opted in
   * ({@link LaunchInput.surfaceDeliverable} !== false) — autonomy/watchdog launches opt OUT because
   * they surface completion through their own settler. Not a money action and creates no new authority
   * (#243 money-only intact); the draft is data, the card is a review receipt. Absent → no surfacing
   * (today's behavior); a sink error never affects the already-finalized session.
   */
  onSessionCompleted?(event: {
    workspaceId: string;
    sessionId: string;
    channelId: string;
    agentMemberId: string;
    /** The task the session was briefed with (for the card summary). */
    task: string;
    /** The already-redacted, bounded result tail (the deliverable/draft). */
    result: string;
    /** Wall-clock compute consumed by the producing session. */
    computeSeconds: number;
  }): Promise<void>;
  /**
   * Optional deliverable-message sink (#393): called best-effort when a session COMPLETES cleanly with a
   * real artifact — so the agent's actual work is posted as a CHAT MESSAGE into its own channel (the
   * fleet's visible reply), not left only on a board card the owner reads as "no response". Gated in the
   * wiring (the agent-channel-posting capability, owner-workspace-first); absent → no posting (today's
   * behavior). A sink error never affects the already-finalized session.
   */
  postDeliverableMessage?(input: {
    workspaceId: string;
    sessionId: string;
    channelId: string | null;
    agentMemberId: string;
    task: string;
    result: string;
  }): Promise<void>;
}

export interface LaunchInput {
  workspaceId: string;
  channelId: string;
  /** Optional task row id for workflow launches; exposed to the harness as AGENT_TASK_ID. */
  taskId?: string;
  agentMemberId: string;
  createdByMemberId: string;
  /** The user's task/prompt — passed to the harness as data (env), never as a command. */
  task: string;
  /** Optional caller-owned idempotency key; duplicate launches return the existing session row. */
  idempotencyKey?: string | null;
  /**
   * Per-session coding-agent harness (#50): overrides the deployment default for THIS session.
   * Validated against the {@link HarnessKind} allowlist (invalid → {@link HarnessKindError}, mapped
   * to a 400) and persisted on the row. Omitted → the env default. Switching claude-code ↔ codex per
   * session works identically under LocalRuntime and SandboxRuntime.
   */
  harness?: HarnessKind;
  /**
   * Speed gap (reload.team feel): request a FAST, lightweight agent turn for THIS session — a cheap
   * model + NO tools + a short cap, so coordination chatter (handoff acks, quick routing, agent↔agent
   * questions) is seconds not minutes instead of a full heavyweight session. Only meaningful for the
   * real `claude-code` harness (demo/codex ignore it). ADDITIVE + DEFAULT-OFF: omitted/false ⇒ today's
   * full spec + default caps, byte-for-byte. No caller opts in yet — this is the capability + plumbing.
   */
  fast?: boolean;
  /** Team Mode: the team run this session belongs to (recorded on its trace for grouping). */
  teamRunId?: string;
  /** Team Mode: the team rollup span this session links under (Braintrust parent span id). */
  parentSpanId?: string;
  /**
   * Subagents (#59): when set, the session's messages thread under this (the invoking @mention)
   * message instead of creating a new root — so a subagent's result returns into the parent thread.
   */
  parentMessageId?: string;
  /**
   * Subagents (#59): extra env merged into the job alongside `AGENT_TASK` (e.g. a persona's
   * `AGENT_APPEND_SYSTEM_PROMPT` / `AGENT_ALLOWED_TOOLS`). Model/provider selection (#52) flows the
   * same way (`ANTHROPIC_MODEL`, provider flags, `MAX_THINKING_TOKENS`, …). Config is data, never
   * argv. When absent the job env is `{ AGENT_TASK }` exactly as before.
   */
  harnessEnv?: Record<string, string>;
  /**
   * Model/provider selection (#52): the **non-secret** selection persisted on the session row for
   * audit + the review UI. The matching env lives in `harnessEnv`; this is metadata only — never a
   * secret. Omitted when no explicit selection was made.
   */
  selection?: {
    provider: ProviderKind;
    model: string;
    effort: EffortLevel;
    mode: SessionMode;
  };
  /**
   * Whether a clean completion should SURFACE its result as a board deliverable artifact (#248).
   * Defaults to `true` (surface) so a user-briefed @mention/department/REST launch never "vanishes" —
   * its draft lands in the APPROVAL NEEDED queue. Autonomy + watchdog-revival launches pass `false`:
   * they own completion via their own settler, so surfacing here would double-card every workflow
   * stage. Only consulted when {@link SessionManagerDeps.onSessionCompleted} is wired.
   */
  surfaceDeliverable?: boolean;
}

/** How many trailing output lines to keep as the persisted result summary. */
const RESULT_TAIL_LINES = 12;
const RESULT_MAX_CHARS = 4000;
/**
 * Minimum gap between liveness-heartbeat writes (#105). Output can be very chatty, so we coalesce the
 * heartbeat to at most one write per this interval — cheap, and far finer-grained than any sane
 * watchdog stale cutoff (minutes), so detection is unaffected.
 */
const HEARTBEAT_MIN_INTERVAL_MS = 10_000;

/**
 * #394: default grace the run loop gives a reaper's `cancel()` to tear down cleanly before it
 * finalizes WITHOUT the runtime — the upper bound on how long a reaped run can stay un-finalized
 * even if `wait()`/`cancel()` are wedged. Generous enough for a real sandbox snapshot+stop to land
 * (so the normal path keeps its exit code + snapshot), short enough that a hung teardown can never
 * leave a run stalled for minutes. See {@link SessionManagerDeps.reapGraceMs}.
 */
export const DEFAULT_REAP_GRACE_MS = 15_000;

/** Fallback short caps for a fast turn (#417) when the env overrides are unset: 60s idle / 180s wall. */
const FAST_IDLE_MS_DEFAULT = 60_000;
const FAST_WALLCLOCK_MS_DEFAULT = 180_000;

interface ToolFailureContext {
  tool: HarnessToolCall;
  error: string;
}

function formatToolFailure(ctx: ToolFailureContext, redact: (text: string) => string): string {
  const rawArgs =
    typeof ctx.tool.args === "string" ? ctx.tool.args : JSON.stringify(ctx.tool.args ?? null);
  const args = redact(rawArgs ?? "").slice(0, 500);
  const error = redact(ctx.error).slice(0, 500);
  return ["failed tool: " + ctx.tool.name, "args: " + args, "error: " + error].join("\n");
}

/**
 * Resolve the SHORT watchdog caps for a fast turn (#417) so a coordination chat turn can't hang for
 * minutes like a full deliverable session. Reads `AGENT_FAST_IDLE_MS` / `AGENT_FAST_WALLCLOCK_MS`
 * (positive integers) with small defaults, and NEVER exceeds the session's default caps — a fast turn
 * is always capped at or below the normal limits, never longer. ADDITIVE: only consulted when a launch
 * opts into `fast`; the default caps are untouched for every other launch.
 */
export function resolveFastCaps(
  defaults: ResourceCaps,
  env: NodeJS.ProcessEnv = process.env,
): ResourceCaps {
  const parse = (raw: string | undefined, fallback: number): number => {
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const idleMs = Math.min(parse(env.AGENT_FAST_IDLE_MS, FAST_IDLE_MS_DEFAULT), defaults.idleMs);
  const wallClockMs = Math.min(
    parse(env.AGENT_FAST_WALLCLOCK_MS, FAST_WALLCLOCK_MS_DEFAULT),
    defaults.wallClockMs,
  );
  return { ...defaults, idleMs, wallClockMs };
}

/**
 * SessionManager — the server-owned orchestrator that makes "close the laptop, agents keep
 * working" real (#25). On launch it persists a session row, then drives the runtime lifecycle
 * (provision → attach → run → snapshot/idle → teardown) entirely server-side: it streams output
 * into the channel as the agent member (so it is live AND persisted), enforces wall-clock + idle
 * caps via a reaper, redacts secrets from everything it logs/posts, and finalizes the row at
 * teardown — independent of any client connection.
 */
export class SessionManager {
  private readonly running = new Map<string, RunningSession>();
  private readonly runs = new Map<string, Promise<void>>();
  /**
   * #778: per-session hard-cancel token. Created synchronously in {@link launch} (so it exists for the
   * whole provision→start→run→teardown lifecycle, including the window BEFORE `runtime.start()` resolves
   * and a {@link RunningSession} lands in {@link running}), tripped by {@link cancel}. The run loop checks
   * it before every dispatch and between steps and threads it into the runtime, so a Stop halts the agent
   * the instant it is pressed — no further tool/runtime dispatch, no respawn, immediate `canceled`.
   */
  private readonly aborts = new Map<string, AbortController>();
  private readonly tracer: AgentTracer;

  constructor(private readonly deps: SessionManagerDeps) {
    this.tracer = deps.tracer ?? noopTracer;
  }

  get runtimeKind(): RuntimeKind {
    return this.deps.runtime.kind;
  }

  /** Number of sessions currently being driven (for tests / introspection). */
  get activeCount(): number {
    return this.running.size;
  }

  /**
   * The ids of the sessions this process is currently driving (#70) — the git-worktree reaper's
   * keep-set, so it never reaps a live run's worktree. Backed by `runs` (set synchronously in
   * {@link launch}, deleted at teardown), NOT `running` (set only *after* the workspace is
   * provisioned): this covers the provision→start window too, so a periodic sweep can't race a
   * session whose worktree exists but whose runtime hasn't attached yet.
   */
  get activeSessionIds(): string[] {
    return [...this.runs.keys()];
  }

  /** Persist + start a session, returning immediately. The run continues server-side. */
  async launch(input: LaunchInput): Promise<AgentSession> {
    const task = redactPotentialSecrets(input.task);
    // Preflight gate (#69): fail fast on a misconfigured cloud/real-agent posture BEFORE we persist
    // a row, acquire an admission slot, or make any runtime/cloud call — so a half-broken session
    // never starts. The default local/demo posture always passes; no gate wired (unit tests) = no-op.
    if (this.deps.preflight) {
      const report = this.deps.preflight();
      if (!report.ok) throw new PreflightError(report);
    }
    // Resolve the per-session harness (#50) BEFORE acquiring an admission slot or persisting, so an
    // invalid kind is rejected without leaking a slot or leaving a half-started session behind.
    const harness = this.resolveHarness(input.harness, input.fast);

    // Fast turn (#417): a coordination chat turn gets SHORT idle/wall-clock caps so it can't hang for
    // minutes like a full deliverable session. Never longer than the default caps. Default launches use
    // the deployment caps unchanged, so production behavior is byte-for-byte today's.
    const caps = input.fast ? resolveFastCaps(this.deps.caps) : this.deps.caps;

    // Auto model-selection (convene-llm-gateway): when no explicit model is pinned, ask the routing
    // layer for the best model for this task. Done BEFORE admission so the (cheap, bounded, fail-open)
    // routing call doesn't hold a concurrency slot; it never throws (a failure degrades to the default).
    const auto = await this.maybeAutoSelectModel({ ...input, task });
    const selectionRow = auto?.selectionRow ?? input.selection;
    let harnessEnv = auto ? auto.harnessEnv : input.harnessEnv;
    if (input.taskId) {
      harnessEnv = { ...harnessEnv, AGENT_TASK_ID: input.taskId };
    }

    // Model preflight: resolve the EFFECTIVE model at the runtime boundary and ALWAYS inject a launchable
    // model as ANTHROPIC_MODEL BEFORE the session spawns. The fleet runs on a managed, always-valid
    // default (claude-opus-4-8) chosen by ipop; an empty / null / unknown value (the `claude-fable-5`
    // class, or an empty "Default" pick) self-heals to that default — the runtime never spawns with an
    // empty or invalid model and is never disabled by a bad value. No-op unless the resolver is wired AND
    // this launch resolves to the real `claude-code` harness.
    const modelPreflight = await this.applyModelPreflight(
      input.workspaceId,
      input.agentMemberId,
      harness.kind,
      harnessEnv,
    );
    harnessEnv = modelPreflight.harnessEnv;
    const effectiveModel = modelPreflight.model;

    // #925 + #71: the enterprise budget cap and scale admission chokepoints. Both deny BEFORE any row is
    // created or runtime/cloud call starts. Enterprise checks first so a blocked launch never acquires a
    // scale slot that would need releasing.
    await this.checkEnterpriseBudget(input, caps);
    const ticket = this.deps.admission
      ? await this.deps.admission.acquire(input.workspaceId)
      : undefined;

    let session: AgentSession;
    try {
      session = await this.deps.store.create({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        agentMemberId: input.agentMemberId,
        createdByMemberId: input.createdByMemberId,
        runtime: this.deps.runtime.kind,
        command: harness.spec.command,
        idempotencyKey: input.idempotencyKey ?? null,
        harness: harness.kind,
        caps,
        provider: selectionRow?.provider ?? null,
        model: selectionRow?.model ?? effectiveModel,
        effort: selectionRow?.effort ?? null,
        mode: selectionRow?.mode ?? null,
        // Auto-selection "why?" audit (convene-llm-gateway): the routing decision when auto-chosen.
        selectionMeta: auto?.decision ?? null,
        region: ticket?.region ?? null,
      });
      if (session.reusedIdempotencyKey) {
        ticket?.release();
        return session;
      }
      await this.deps.usage?.recordStart(input.workspaceId);
    } catch (err) {
      // The slot was acquired but the session never started — free it so it isn't leaked.
      ticket?.release();
      throw err;
    }

    // #778: the hard-cancel token for THIS run. Created here — synchronously, before `drive` is kicked
    // off — so a Stop pressed during provisioning (before any `RunningSession` exists) is still observed
    // by the run loop and dispatches nothing.
    const abort = new AbortController();
    this.aborts.set(session.id, abort);
    const run = this.drive(session, task, {
      teamRunId: input.teamRunId,
      parentSpanId: input.parentSpanId,
      parentMessageId: input.parentMessageId,
      harnessEnv,
      spec: harness.spec,
      decode: harness.decode,
      ticket,
      surfaceDeliverable: input.surfaceDeliverable,
      caps,
      signal: abort.signal,
    }).catch((err: unknown) => {
      // #248 silent-vanish defense: `runSession` finalizes the row on every normal path, but a throw
      // BEFORE its inner try (secrets.resolve / loadConfig) or in the tracer escapes here. Previously
      // swallowed → the row stayed `provisioning` forever with NO failure recorded (the session
      // "vanished"). Now we best-effort force-finalize it to `failed` with the real reason and route the
      // failure, so a briefed task NEVER disappears without a surfaced outcome.
      void this.finalizeOrphanedFailure(session, err);
    });
    this.runs.set(session.id, run);
    void run.finally(() => {
      this.runs.delete(session.id);
      this.aborts.delete(session.id);
    });
    return session;
  }

  private async checkEnterpriseBudget(input: LaunchInput, caps: ResourceCaps): Promise<void> {
    if (!this.deps.enterprise) return;
    const rate = this.deps.enterpriseComputeRateCentsPerMinute?.(input.workspaceId) ?? 0;
    if (!Number.isFinite(rate) || rate <= 0) return;
    const requestCents = Math.max(0, Math.round((caps.wallClockMs / 60_000) * rate));
    if (requestCents <= 0) return;
    const outcome = await this.deps.enterprise.decideSpend({
      workspaceId: input.workspaceId,
      agentId: input.agentMemberId,
      requesterMemberId: input.createdByMemberId,
      requestCents,
    });
    if (outcome.status === "breach_gated") {
      throw new SpendCapBreachError(
        outcome.approvalRequestId,
        requestCents,
        outcome.decision.reason,
      );
    }
  }

  /**
   * Resolve the harness for a launch (#50): the env default, or a validated per-session override.
   * Returns the trusted spec + its output decoder + the kind to persist. Throws
   * {@link HarnessKindError} for an unknown kind, or an override the manager has no resolver for.
   */
  private resolveHarness(
    override?: HarnessKind,
    fast?: boolean,
  ): {
    kind: HarnessKind;
    spec: HarnessSpec;
    decode: LineDecoder;
  } {
    const defaultKind = this.deps.harnessKind ?? "demo";
    const defaultDecode: LineDecoder =
      this.deps.decodeOutput ?? ((line) => ({ display: [line], raw: null }));
    if (override === undefined || override === defaultKind) {
      // A fast turn (#417) needs a DIFFERENT spec (cheap model + no tools), so it cannot reuse the
      // pre-built default `{ command, args }` — it must go through the override resolver to rebuild the
      // spec with `fast`. When not fast (the default), the pre-built default spec is used unchanged, so
      // production is byte-for-byte today's behavior. If no resolver is wired (unit tests with only the
      // legacy default harness), a fast request degrades to the default spec — never a hard failure.
      if (fast && this.deps.harnessOverrides) {
        const resolved = this.deps.harnessOverrides(defaultKind, { fast: true });
        return {
          kind: defaultKind,
          spec: { command: resolved.command, args: resolved.args },
          decode: resolved.decode,
        };
      }
      return { kind: defaultKind, spec: this.deps.harness, decode: defaultDecode };
    }
    if (!isHarnessKind(override)) throw new HarnessKindError(override);
    if (!this.deps.harnessOverrides) {
      throw new HarnessKindError(
        override,
        "cannot be selected (no harness override resolver wired)",
      );
    }
    const resolved = this.deps.harnessOverrides(override, { fast });
    return {
      kind: override,
      spec: { command: resolved.command, args: resolved.args },
      decode: resolved.decode,
    };
  }

  /**
   * Auto model-selection (convene-llm-gateway): pick the best model for a launch that pins NO explicit
   * model. Returns the selection-row fields, the merged harness env (chosen `ANTHROPIC_MODEL` + provider
   * flags, with the caller's env winning on any other key), and the "why?" decision — or `undefined` to
   * keep the deployment default. Precedence: an explicit per-session selection (#52) or a model already
   * in `harnessEnv` ALWAYS wins, so auto only fills the gap. Never throws (the resolver is fail-open).
   */
  private async maybeAutoSelectModel(input: LaunchInput): Promise<
    | {
        selectionRow: {
          provider: ProviderKind;
          model: string;
          effort: EffortLevel;
          mode: SessionMode;
        };
        harnessEnv: Record<string, string>;
        decision: AutoModelDecision;
      }
    | undefined
  > {
    if (!this.deps.autoModel) return undefined;
    // Explicit per-session selection (#52) always wins over auto.
    if (input.selection) return undefined;
    // A model already pinned in the caller's env (e.g. a persona's ANTHROPIC_MODEL) also wins.
    if (input.harnessEnv?.ANTHROPIC_MODEL) return undefined;

    const auto = await this.deps.autoModel.resolve({
      workspaceId: input.workspaceId,
      task: input.task,
    });
    if (!auto) return undefined;

    return {
      selectionRow: {
        provider: auto.selection.provider,
        model: auto.selection.model,
        effort: auto.selection.effort,
        mode: auto.selection.mode,
      },
      // Auto env first (provides ANTHROPIC_MODEL + provider flags); caller env wins on any other key.
      // ANTHROPIC_MODEL can't collide — we only reach here when the caller pinned none.
      harnessEnv: { ...auto.selection.env, ...input.harnessEnv },
      decision: auto.decision,
    };
  }

  /**
   * Model preflight: resolve the effective launch model and ALWAYS inject it as `ANTHROPIC_MODEL` BEFORE
   * any session spawns. Precedence: a per-session #52 pin (`ANTHROPIC_MODEL` in `harnessEnv`) > the
   * workspace/dev override > the deployment env default > the managed default. Empty / null / unknown
   * candidates are skipped and the chain falls back to the managed {@link DEFAULT_AGENT_MODEL}, so the
   * runtime never spawns with an empty or invalid model and the fleet is never disabled by a bad value
   * (it self-heals instead of throwing). Because the resolved model is always written into the child's
   * env, the spawn never depends on `process.env.ANTHROPIC_MODEL` being correctly set. Only acts for the
   * real `claude-code` harness with the resolver wired — otherwise returns `harnessEnv` unchanged.
   */
  private async applyModelPreflight(
    workspaceId: string,
    agentMemberId: string,
    harnessKind: HarnessKind,
    harnessEnv: Record<string, string> | undefined,
  ): Promise<{ harnessEnv: Record<string, string> | undefined; model: string | null }> {
    // The model only reaches the child via `--model "$ANTHROPIC_MODEL"` on the claude-code harness.
    if (harnessKind !== "claude-code" || !this.deps.modelForWorkspace) {
      return { harnessEnv, model: null };
    }
    const sessionPinned = harnessEnv?.ANTHROPIC_MODEL ?? null;
    const agentPicked =
      sessionPinned === null && this.deps.modelForAgent
        ? await this.deps.modelForAgent(workspaceId, agentMemberId)
        : null;
    const workspacePicked = await this.deps.modelForWorkspace(workspaceId);
    // Guaranteed-launchable — never throws, never empty. An empty "Default" pick or an unservable id
    // resolves to the managed default here, at the runtime boundary.
    const model = resolveLaunchModel({
      sessionPinned,
      agentPicked,
      workspacePicked,
      envDefault: this.deps.envDefaultModel ?? null,
    });
    // Always inject the resolved model so the child spawns with a valid `--model`, independent of whether
    // process.env carries (or lacks) a deployment default.
    return { harnessEnv: { ...harnessEnv, ANTHROPIC_MODEL: model }, model };
  }

  /**
   * Cancel a session so the owner can ALWAYS kill a runaway (#248) — and so Stop HARD-HALTS it the
   * instant it is pressed (#778). Two paths:
   *  - Driven by THIS process (a hard-cancel token exists) → trip the token FIRST, synchronously and
   *    before any `await`, so the run loop dispatches nothing further and never respawns (it checks the
   *    token before every step). Then signal any in-flight {@link RunningSession} (SIGKILLs the child /
   *    tears the sandbox down) so a step already running is aborted, and AWAIT the driven lifecycle so the
   *    DB row is already `canceled` when this resolves — otherwise a UI that polls right after Stop could
   *    still read `running` and the card would flicker back (gemini #249 review note). This covers all
   *    three windows — before the first step, mid-step, and between steps (during a retry backoff) —
   *    because the token is set at {@link launch}, not only once a {@link RunningSession} exists.
   *  - NOT driven here (an orphan left `running` by a deploy/restart, or a session driven by another
   *    machine — the 30-min stuck Scout) → force-finalize the DB row to `canceled` directly, so it leaves
   *    the live board immediately even though no process is holding it. Race-safe: the guarded store
   *    update is a no-op (returns false) if the row already went terminal.
   * Idempotent; returns whether the cancel took effect.
   */
  async cancel(id: string): Promise<boolean> {
    const abort = this.aborts.get(id);
    const run = this.runs.get(id);
    if (abort || run) {
      // Trip the hard-cancel token BEFORE awaiting anything: the run loop guards on it before every
      // dispatch and between steps, so this synchronously guarantees no further tool/runtime call and no
      // respawn — even if the loop is mid-`await` in provisioning or a retry backoff right now.
      abort?.abort();
      // Abort an in-flight step if one is already running (the manager-driven path the loop can't reach
      // until `start()` resolves is handled by the token + the loop's own post-start re-check).
      const running = this.running.get(id);
      if (running) await running.cancel("canceled");
      // `drive` never rejects (its terminal failures are persisted), so awaiting it is safe; absent
      // (already torn down) ⇒ resolves immediately. Guarantees the terminal `canceled` row is written.
      await run;
      return true;
    }
    // Orphan / cross-process: there is no token or live run here — finalize the durable row so a runaway
    // can still be killed from the UI. Absent forceFinalize (a bare fake store) ⇒ unchanged: cannot cancel.
    if (this.deps.store.forceFinalize) {
      return this.deps.store.forceFinalize(id, {
        status: "canceled",
        result: "Canceled by the owner (no live process was attached — orphaned or cross-process).",
      });
    }
    return false;
  }

  /**
   * Inject steering guidance into a live, in-flight session (#53). Mirrors {@link cancel}: it only
   * touches a session this manager is actively driving and only delivers when the runtime supports
   * steering. Returns whether the guidance reached the process (false for an unknown/terminal session
   * or a runtime without steering — the caller still records the steer message in the channel).
   */
  async steer(id: string, text: string): Promise<boolean> {
    const running = this.running.get(id);
    if (!running?.steer) return false;
    await running.steer(text);
    return true;
  }

  /** Await a session's server-side completion (test/introspection helper). */
  async join(id: string): Promise<void> {
    await this.runs.get(id);
  }

  /** Cancel every in-flight session and wait for teardown — used on server shutdown. */
  async shutdown(): Promise<void> {
    // #778: trip every hard-cancel token first so a session caught between steps (not yet in `running`)
    // halts and never respawns, then signal any in-flight steps and wait for teardown.
    for (const abort of this.aborts.values()) abort.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.cancel("canceled")));
    await Promise.allSettled([...this.runs.values()]);
  }

  private async drive(
    session: AgentSession,
    task: string,
    opts: {
      teamRunId?: string;
      parentSpanId?: string;
      parentMessageId?: string;
      harnessEnv?: Record<string, string>;
      /** The resolved per-session harness spec + decoder (#50). */
      spec: HarnessSpec;
      decode: LineDecoder;
      /** Cloud-scale admission ticket (#71): released at teardown. */
      ticket?: AdmissionTicket;
      /** #248: surface a clean completion's result as a board deliverable (default true). */
      surfaceDeliverable?: boolean;
      /** The effective resource caps for THIS session (#417 fast turn uses short caps). */
      caps: ResourceCaps;
      /** #778: the hard-cancel token for this run (tripped by {@link cancel}). */
      signal: AbortSignal;
    },
  ): Promise<void> {
    const log = this.deps.logger.child({
      sessionId: session.id,
      workspaceId: session.workspaceId,
      runtime: this.deps.runtime.kind,
    });
    recordSessionStarted();
    // Observability: wrap the whole session in one span (task -> output/status). The tracer is a
    // no-op unless BRAINTRUST_API_KEY is set, so tests / CI / local dev are unaffected. Under Team
    // Mode the span links to the team rollup via parentSpanId.
    await this.tracer.session(
      {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        agentMemberId: session.agentMemberId,
        runtime: this.deps.runtime.kind,
        model: session.model,
        task,
        teamRunId: opts.teamRunId,
        parentSpanId: opts.parentSpanId,
      },
      () =>
        this.runSession(session, task, log, {
          parentMessageId: opts.parentMessageId,
          harnessEnv: opts.harnessEnv,
          spec: opts.spec,
          decode: opts.decode,
          ticket: opts.ticket,
          surfaceDeliverable: opts.surfaceDeliverable,
          caps: opts.caps,
          signal: opts.signal,
        }),
    );
  }

  /** The driven session lifecycle (provision -> run -> finalize); returns a trace-friendly outcome. */
  private async runSession(
    session: AgentSession,
    task: string,
    log: SessionLogger,
    opts: {
      parentMessageId?: string;
      harnessEnv?: Record<string, string>;
      spec: HarnessSpec;
      decode: LineDecoder;
      ticket?: AdmissionTicket;
      surfaceDeliverable?: boolean;
      /** The effective resource caps for THIS session (#417 fast turn uses short caps). */
      caps: ResourceCaps;
      /** #778: the hard-cancel token for this run (tripped by {@link cancel}). */
      signal: AbortSignal;
    },
  ): Promise<AgentSessionOutcome> {
    const signal = opts.signal;
    // Secrets are resolved per tenant at provision and injected as runtime env only. #151: the launching
    // agent's member id scopes the resolution — with the credential matrix OFF (default) this is a no-op
    // passthrough; when enabled the resolver filters to that agent's allowlisted keys.
    const secrets = await this.deps.secrets.resolve(session.workspaceId, {
      agentMemberId: session.agentMemberId,
    });
    const redact = makeRedactor(secrets);
    // #151: the per-tenant egress allowlist rides on the job into the sandbox (the kernel-enforcement
    // seam). OFF (default) ⇒ undefined = unrestricted, today's behavior.
    const egressPolicy = resolveEgressPolicy(loadConfig(session.workspaceId).egress);
    const egress = egressPolicy.enabled ? egressPolicy.allowlist : undefined;

    // Post the parent "started" message before any output so streamed lines thread under it. For a
    // subagent invocation (#59) the invoking @mention message is the thread root, so the started
    // message and every streamed line thread under it — the result returns into the parent thread.
    const start = await this.safePost(
      session,
      `🤖 session ${session.id} started: ${task}`,
      log,
      opts.parentMessageId,
    );
    const parentMessageId = opts.parentMessageId ?? start?.id;

    // Stream state: line-buffer output, keep a redacted tail for the result. Each raw line is run
    // through the harness-aware decoder (#81): for `claude-code` this turns stream-json events into
    // readable channel text and surfaces tool calls; for the demo harness it is a verbatim
    // pass-through (unchanged). The decoder is pure rendering — redaction is applied AFTER it, so a
    // secret leaked inside a decoded event/tool input is still scrubbed before it is posted or logged.
    const decode: LineDecoder = opts.decode;
    let buffer = "";
    const tail: string[] = [];
    // Streamed line posts are serialized through one chain (rather than fire-and-forget) so they land
    // in the channel in emission order, and so we can flush them before the terminal message +
    // finalize — otherwise a consumer reading right after the session goes terminal can see streamed
    // lines out of order or missing entirely (they were still in flight). safePost never rejects, so
    // the chain never breaks.
    let postChain: Promise<unknown> = Promise.resolve();
    // #251: a `claude -p` run can exit 0 yet end its stream with a terminal error event
    // (`{type:'result', is_error:true}` — a usage cap, a tool error, "I'm missing a tool I need"). The
    // PROCESS succeeded but the RUN failed with no artifact. Watch the decoded events for that signal so
    // the run is finalized as a failure (not surfaced as a green check / "deliverable ready for review").
    let harnessReportedError = false;
    // The agent's final substantive answer (the produced artifact), tracked separately from the rolling
    // channel tail so a deliverable card shows the WORK PRODUCT, not the transcript head (narration +
    // tool-call traces). Updated from the harness's structured final-answer event; the last value wins
    // (codex emits several; claude-code emits one terminal `result`). Redacted like every other surface.
    let finalAnswer = "";
    let lastToolCall: HarnessToolCall | null = null;
    let failedTool: ToolFailureContext | null = null;
    // #436 idempotency anchors: did the SESSION ever emit output / fire a heartbeat across its attempts?
    // The moment either is true, a dead attempt may have taken a real/money action, so it is NEVER retried.
    let sawOutput = false;
    let sawHeartbeat = false;
    const emitLine = (line: string): void => {
      const decoded = decode(line);
      // Preserve the raw structured event for run-log / turns consumers — redacted before it lands in
      // the structured log so secrets never persist there either.
      if (decoded.raw !== null) {
        const tool = toolCallFromEvent(decoded.raw);
        if (tool) lastToolCall = tool;
        const eventError = errorMessageFromEvent(decoded.raw);
        if (eventError && lastToolCall) failedTool = { tool: lastToolCall, error: eventError };
        log.info({ event: redact(JSON.stringify(decoded.raw)) }, "agent stream event");
        if (harnessEventReportsError(decoded.raw)) {
          harnessReportedError = true;
          if (!failedTool && lastToolCall) {
            failedTool = {
              tool: lastToolCall,
              error: eventError ?? "agent run ended with an error",
            };
          }
        }
        const answer = finalAnswerFromEvent(decoded.raw);
        if (answer !== null) finalAnswer = redact(answer);
      }
      for (const text of decoded.display) {
        const clean = redact(text).trimEnd();
        if (!clean) continue;
        tail.push(clean);
        if (tail.length > RESULT_TAIL_LINES) tail.shift();
        postChain = postChain.then(() => this.safePost(session, clean, log, parentMessageId));
      }
    };

    // --- liveness heartbeat (#105): coalesced proof-of-progress write the watchdog reads ---
    let lastBeatAt = 0;
    const beat = (): void => {
      if (!this.deps.store.heartbeat) return;
      const t = Date.now();
      if (t - lastBeatAt < HEARTBEAT_MIN_INTERVAL_MS) return;
      lastBeatAt = t;
      sawHeartbeat = true; // proof of progress — a retried attempt must not re-run past this point (#436)
      // Fire-and-forget: a heartbeat hiccup must never fail an otherwise-healthy run.
      void this.deps.store.heartbeat(session.id).catch((err: unknown) => {
        log.error({ err }, "agent session heartbeat failed");
      });
    };

    // --- reaper: wall-clock + idle (no-output) timers ---
    // The wall-clock timer spans the WHOLE session (it is not reset between #436 retries), so the overall
    // lifetime stays bounded; `reaped` short-circuits any pending retry the instant a reaper fires.
    //
    // #394: the reaper used to only call `cancel()` and trust `wait()` to resolve. A wedged teardown
    // (a sandbox `snapshot()`/`stop()` cloud call that hangs) leaves BOTH `wait()` and `cancel()` stuck,
    // so the loop would block on `await running.wait()` forever and the run would hang in `running`. The
    // `reapDeadline` promise closes that: when a reaper fires it calls `cancel()` (a clean-teardown
    // chance), then arms a bounded grace timer; if `wait()` hasn't resolved by then the deadline resolves
    // with the synthetic reap result so the loop ALWAYS finalizes in bounded time. `wait()` never rejects
    // and is left to settle in the background, so racing it can never drop a real result on the floor.
    const reapGraceMs = this.deps.reapGraceMs ?? DEFAULT_REAP_GRACE_MS;
    let reaped = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let resolveReap: ((r: RuntimeResult) => void) | undefined;
    const reapDeadline = new Promise<RuntimeResult>((resolve) => {
      resolveReap = resolve;
    });
    const fireReap = (reason: "idle" | "timeout"): void => {
      if (reaped) return; // first reaper to fire wins; the second is a no-op
      reaped = true;
      log.warn(
        reason === "idle" ? { idleMs: opts.caps.idleMs } : { wallClockMs: opts.caps.wallClockMs },
        reason === "idle" ? "agent session idle-reaped" : "agent session wall-clock reaped",
      );
      void runningRef?.cancel(reason).catch(() => {}); // best-effort clean teardown; never throws into the timer
      graceTimer = setTimeout(() => {
        log.error(
          { reason, graceMs: reapGraceMs },
          "agent session reap grace elapsed; finalizing without runtime teardown (wedged wait/cancel)",
        );
        resolveReap?.({ status: statusForReason(reason), exitCode: null });
      }, reapGraceMs);
      graceTimer.unref?.();
    };
    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fireReap("idle"), opts.caps.idleMs);
    };
    const wallTimer = setTimeout(() => fireReap("timeout"), opts.caps.wallClockMs);

    let runningRef: RunningSession | undefined;
    let result: RuntimeResult = { status: "failed", exitCode: null };
    // #71: the session's wall-clock lifetime is the compute-seconds we bill the tenant for.
    const runStart = Date.now();
    let spendGuard: SpendGuardSession | null = null;
    let spendTimer: NodeJS.Timeout | undefined;
    let spendKilled = false;
    const checkSpend = async (): Promise<void> => {
      if (!spendGuard || spendKilled) return;
      const elapsedSeconds = Math.max(0, Math.round((Date.now() - runStart) / 1000));
      try {
        const check = await spendGuard.check(elapsedSeconds);
        if (!check.kill) return;
        spendKilled = true;
        log.warn(
          {
            reason: check.reason,
            elapsedSeconds,
            estimatedCostCents: check.live.estimatedCostCents,
            budgetCents: check.live.budgetCents,
          },
          "agent session spend anomaly guard canceled runaway session",
        );
        await this.safePost(
          session,
          "Warning: session " +
            session.id +
            " paused: spend guard hit " +
            (check.reason ?? "budget threshold") +
            " (" +
            check.live.estimatedCostCents +
            "c estimated this session).",
          log,
          parentMessageId,
        );
        await runningRef
          ?.cancel("canceled")
          .catch((err: unknown) => log.error({ err }, "spend anomaly cancel failed"));
      } catch (err) {
        log.error({ err }, "spend anomaly check failed");
      }
    };
    try {
      spendGuard =
        (await this.deps.spendAnomaly?.begin({
          sessionId: session.id,
          workspaceId: session.workspaceId,
          channelId: session.channelId,
          agentMemberId: session.agentMemberId,
          createdByMemberId: session.createdByMemberId ?? session.agentMemberId,
          task,
          startedAtMs: runStart,
        })) ?? null;
      if (spendGuard) {
        spendTimer = setInterval(
          () => void checkSpend(),
          Math.max(250, this.deps.spendAnomalyIntervalMs ?? 15_000),
        );
        spendTimer.unref?.();
      }
      // #58: prepare the per-session workspace (copy files-to-copy in) when a provisioner is wired.
      const prepared = await this.deps.workspace?.prepare({
        sessionId: session.id,
        workspaceId: session.workspaceId,
      });
      const safeHarnessEnv = Object.fromEntries(
        Object.entries(opts.harnessEnv ?? {}).map(([key, value]) => [
          key,
          redactPotentialSecrets(value),
        ]),
      );
      const startSpec = {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        command: opts.spec.command,
        args: opts.spec.args,
        env: { AGENT_TASK: task, ...safeHarnessEnv },
        cwd: prepared?.cwd,
        secrets,
        // #71: the runtime provisions in the placed region (sandbox backend); local ignores it.
        region: opts.ticket?.region,
        // #151: the session's egress allowlist (undefined when OFF — unrestricted, #25 default).
        egress,
        caps: opts.caps,
        // #778: thread the hard-cancel token into the runtime so an in-flight OUTBOUND call (sandbox
        // provisioning / run) is aborted the instant Stop is pressed — the provisioning window the
        // manager itself can't reach (no RunningSession exists until start() resolves).
        signal,
      };
      const onStartOutput = {
        onOutput: (_stream: "stdout" | "stderr", chunk: string) => {
          sawOutput = true; // any output ⇒ the attempt may have acted; it can never be retried (#436)
          resetIdle();
          beat();
          buffer += chunk;
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            emitLine(line);
          }
        },
      };
      // #436: bounded inline retry for a transient, PRE-PROGRESS session death. One loop covers BOTH a
      // `start()` throw (no process ran) AND a process that started then died returning a `null` exit code —
      // but ONLY while the session has produced no output and no heartbeat, so re-attempting can never
      // duplicate a real/money action (#200 §4). The wall-clock timer is NOT reset between attempts (overall
      // lifetime stays bounded); `reaped` short-circuits a pending retry. Default OFF (`<= 1` ⇒ one attempt).
      const maxAttempts = this.deps.sessionRetryMaxAttempts ?? this.deps.spawnRetryMaxAttempts ?? 1;
      for (let attempt = 1; ; attempt++) {
        // #778: hard-cancel guard — checked BEFORE every dispatch and BETWEEN steps. A Stop pressed
        // before the first step, or during a retry backoff, lands here and the loop finalizes `canceled`
        // WITHOUT ever calling `runtime.start()` again — no post-stop dispatch, no respawn.
        if (signal.aborted) {
          result = { status: "canceled", exitCode: null };
          break;
        }
        const attemptStart = Date.now();
        let running: RunningSession | undefined;
        try {
          running = await this.deps.runtime.start(startSpec, onStartOutput);
          runningRef = running;
          this.running.set(session.id, running);
          // #778: a Stop can race in WHILE start() is provisioning — by the time it resolves the token is
          // already tripped but cancel() saw no RunningSession to signal. Tear this just-started step down
          // now so wait() resolves `canceled` immediately and we never stream past the Stop.
          if (signal.aborted) await running.cancel("canceled").catch(() => {});
          observeSpinup(this.deps.runtime.kind, (Date.now() - attemptStart) / 1000);
          resetIdle();
          await this.deps.store.markRunning(session.id, running.sandboxId);
          // #394: race the runtime's wait() against the bounded reap deadline so a wedged
          // teardown (wait()/cancel() never settling) can never hang the loop here.
          result = await Promise.race([running.wait(), reapDeadline]);
        } catch (attemptErr) {
          // `start()`/`markRunning()` threw: a pre-process death (no exit code). Tear down any started
          // child best-effort so a retry never leaves an orphan running, then treat it as a null-exit failure.
          log.warn(
            { attempt, err: redactError(attemptErr, redact) },
            "agent session attempt failed to start",
          );
          if (running) await running.cancel("failed").catch(() => {});
          result = { status: "failed", exitCode: null };
        } finally {
          this.running.delete(session.id);
        }

        const decision = decideSessionRetry({
          attempt,
          maxAttempts,
          status: result.status,
          exitCode: result.exitCode,
          sawOutput,
          sawHeartbeat,
          policy: this.deps.sessionRetryBackoff,
        });
        if (!decision.retry || reaped || signal.aborted) break;
        recordSessionRetry(this.deps.runtime.kind);
        log.warn(
          { attempt, backoffMs: decision.backoffMs, reason: decision.reason },
          "agent session died with no progress; retrying after backoff",
        );
        // #778: an abortable backoff — a Stop during the wait wakes it at once, and the loop's top guard
        // then finalizes `canceled` instead of sleeping out the full delay before re-checking.
        await delayUntilAbort(decision.backoffMs, signal);
      }
    } catch (err) {
      log.error({ err: redactError(err, redact) }, "agent session failed to run");
      result = { status: "failed", exitCode: null };
    } finally {
      if (spendTimer) clearInterval(spendTimer);
      if (spendGuard) {
        await checkSpend();
        spendGuard.close();
      }
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(wallTimer);
      if (graceTimer) clearTimeout(graceTimer); // #394: drop the reap grace timer on every teardown path
      this.running.delete(session.id);
      // #71: free the admission slot on every teardown path (success, failure, reap, cancel) so a
      // crashed/timed-out session never permanently consumes a tenant's concurrency budget.
      opts.ticket?.release();
    }

    if (buffer.trim()) emitLine(buffer); // flush a trailing partial line
    await postChain; // ensure every streamed line is persisted (in order) before the terminal message

    let resultText = tail.join("\n").slice(0, RESULT_MAX_CHARS);
    // The agent's produced artifact: its structured final answer when the harness marked one, else the
    // rolling tail (the demo / plain-text harness has no final event). This is what a deliverable card
    // shows AND the evidence the disposition weighs for "did it actually produce real output?".
    const artifact = (finalAnswer.trim() ? finalAnswer : resultText).slice(0, RESULT_MAX_CHARS);
    // #319 / #251 / #200: ONE honest read of the run. A clean process exit is reconciled to `failed`
    // whenever it didn't really finish real work — a harness error event (#251) OR the agent self-reporting
    // that it never booted ("I couldn't start up — my runtime is missing a tool", the `(spawn)` board bug).
    // `disposition.done` is the single gate for surfacing a deliverable: a clean completion that produced a
    // REAL artifact (#200 production-grounded). Every consumer below (terminal message, finalize, failure
    // routing, recovery, deliverable surfacing) keys off the reconciled `result.status` / `disposition.done`,
    // so one decision fixes all of them — a failed-to-start or no-output run can never show as done/shipped.
    // The exit code is left untouched (an honest `exit 0`) — the failure class is refined from the output.
    const disposition = decideSessionDisposition({
      status: result.status,
      exitCode: result.exitCode,
      harnessReportedError,
      artifact,
    });
    if (disposition.status !== result.status) {
      result = { ...result, status: disposition.status };
    }
    if (failedTool && !isSuccess(result.status)) {
      resultText = [formatToolFailure(failedTool, redact), resultText]
        .filter(Boolean)
        .join("\n")
        .slice(0, RESULT_MAX_CHARS);
    }
    // #166: a green check ONLY on a clean completion. A failed/timed-out/canceled session renders a
    // failure mark + brand-voice reason (spawn/auth/timeout/budget/…) instead of the old lying
    // "✅ session failed (exit n/a)". `resultText` is already redacted; it's passed only to refine the
    // reason class (auth markers) and is never echoed back into the message.
    await this.safePost(
      session,
      renderSessionOutcome({
        status: result.status,
        exitCode: result.exitCode,
        outputTail: resultText,
      }),
      log,
    );
    await this.deps.store.finalize(session.id, {
      status: result.status,
      exitCode: result.exitCode,
      result: resultText || null,
      snapshotId: result.snapshotId ?? null,
    });
    recordSessionEnded(this.deps.runtime.kind, result.status);
    // #230: route a genuine failure to self-healing/escalation (#117) instead of letting it die in
    // silence. Only runtime/harness failures (spawn-and-die, crash, timeout) are routed — an auth/budget
    // stop needs the OWNER to act (a fix agent can't), and a cancel is intentional. Best-effort: a sink
    // error must never affect an already-finalized session.
    if (this.deps.onSessionFailure && !isSuccess(result.status)) {
      const failureClass = classifyFailure({
        status: result.status,
        exitCode: result.exitCode,
        outputTail: resultText,
      });
      // #242: a "model" misconfig (a `--model` the API can't serve) is ALSO routed — owner-actionable,
      // surfaced as a self-healing incident (not a doomed auto-fix agent). auth/budget stay unrouted (the
      // owner alone can act). The real error excerpt rides along so the surface names the actual cause.
      if (
        failureClass === "spawn" ||
        failureClass === "error" ||
        failureClass === "timeout" ||
        failureClass === "model"
      ) {
        await this.deps
          .onSessionFailure({
            workspaceId: session.workspaceId,
            sessionId: session.id,
            channelId: session.channelId,
            agentMemberId: session.agentMemberId,
            status: result.status,
            exitCode: result.exitCode,
            failureClass,
            message: failureCopy(failureClass).headline,
            // Already redacted (resultText is the redacted tail); bounded so the surface stays compact.
            errorExcerpt: resultText ? resultText.slice(0, 240) : undefined,
          })
          .catch((err: unknown) => log.error({ err }, "session failure routing failed"));
      }
    }
    // #238: a clean completion is the production-grounded proof the runtime recovered — resolve any open
    // agent-runtime spawn incident (#193) so a self-healing incident opened by a spawn cluster closes
    // itself once real sessions succeed again. Best-effort; never affects the finalized session.
    if (this.deps.onSessionRecovered && isSuccess(result.status)) {
      await this.deps
        .onSessionRecovered({ workspaceId: session.workspaceId, sessionId: session.id })
        .catch((err: unknown) => log.error({ err }, "session recovery routing failed"));
    }
    const computeSeconds = Math.max(0, Math.round((Date.now() - runStart) / 1000));
    // #248: surface a clean completion's deliverable as a board artifact so a briefed task NEVER
    // vanishes — its draft lands in the APPROVAL NEEDED queue instead of living only as a channel
    // message + result row. #319: gated on `disposition.done` — the ONE source of truth — so a run that
    // failed to start, ended in a harness error (#251), or produced no real artifact is NEVER surfaced as
    // a done/shipped card (the "5-tweet launch thread shown shipped despite failing to start" bug). Only
    // when the launch opted in (autonomy/watchdog pass surfaceDeliverable:false — own settler). Best-effort.
    if (this.deps.onSessionCompleted && disposition.done && opts.surfaceDeliverable !== false) {
      // The deliverable is the same `artifact` the disposition judged real (final answer, else the tail).
      const deliverable = artifact;
      await this.deps
        .onSessionCompleted({
          workspaceId: session.workspaceId,
          sessionId: session.id,
          channelId: session.channelId,
          agentMemberId: session.agentMemberId,
          task,
          result: deliverable,
          computeSeconds,
        })
        .catch((err: unknown) => log.error({ err }, "session deliverable surfacing failed"));
    }
    // #393: post the agent's actual deliverable as a chat MESSAGE into its channel — the fleet's visible
    // reply. Without this the work lands only on a board card and the owner sees "no response". Gated in
    // the wiring; best-effort (never affects the finalized session); only on disposition.done so narration
    // or a failed boot (#319) never posts.
    if (this.deps.postDeliverableMessage && disposition.done) {
      await this.deps
        .postDeliverableMessage({
          workspaceId: session.workspaceId,
          sessionId: session.id,
          channelId: session.channelId,
          agentMemberId: session.agentMemberId,
          task,
          result: artifact,
        })
        .catch((err: unknown) => log.error({ err }, "session deliverable message post failed"));
    }
    // #71: account the compute consumed so a per-tenant budget can bite on the next launch. Pure
    // accounting — a recorder hiccup must never fail an already-finalized session.
    if (this.deps.usage) {
      await this.deps.usage
        .recordCompute(session.workspaceId, computeSeconds)
        .catch((err: unknown) => log.error({ err }, "usage compute accounting failed"));
    }
    log.info({ status: result.status, snapshotId: result.snapshotId }, "agent session finalized");
    return { status: result.status, exitCode: result.exitCode ?? null, result: resultText || null };
  }

  /**
   * #248 silent-vanish defense: a session whose {@link drive} threw BEFORE `runSession` could finalize
   * (a pre-`try` secrets/config throw, or a tracer throw) is stuck at `provisioning` with no record.
   * Best-effort force-finalize it to `failed` with the real (redacted) reason and route the failure so
   * it surfaces in recentFailures / self-healing — a briefed task never disappears without an outcome.
   * The guarded store update is a no-op if the row already reached a terminal state.
   */
  private async finalizeOrphanedFailure(session: AgentSession, err: unknown): Promise<void> {
    const reason = err instanceof Error ? err.message : String(err);
    const log = this.deps.logger.child({ sessionId: session.id, workspaceId: session.workspaceId });
    log.error({ err }, "agent session failed before start — finalizing as failed (#248)");
    const detail = `session failed before start: ${reason}`.slice(0, RESULT_MAX_CHARS);
    let finalized = false;
    try {
      if (this.deps.store.forceFinalize) {
        finalized = await this.deps.store.forceFinalize(session.id, {
          status: "failed",
          result: detail,
          exitCode: null,
        });
      } else {
        await this.deps.store.finalize(session.id, {
          status: "failed",
          exitCode: null,
          result: detail,
        });
        finalized = true;
      }
    } catch (e: unknown) {
      log.error({ err: e }, "failed to finalize an orphaned session (#248)");
    }
    if (finalized && this.deps.onSessionFailure) {
      await this.deps
        .onSessionFailure({
          workspaceId: session.workspaceId,
          sessionId: session.id,
          channelId: session.channelId,
          agentMemberId: session.agentMemberId,
          status: "failed",
          exitCode: null,
          failureClass: "spawn",
          message: failureCopy("spawn").headline,
          errorExcerpt: detail.slice(0, 240),
        })
        .catch((e: unknown) => log.error({ err: e }, "orphaned-failure routing failed (#248)"));
    }
  }

  /** Post to the channel without ever letting a delivery error fail the session. */
  private async safePost(
    session: AgentSession,
    body: string,
    log: SessionLogger,
    parentMessageId?: string,
  ): Promise<{ id: string } | undefined> {
    try {
      return await this.deps.poster.post({
        workspaceId: session.workspaceId,
        channelId: session.channelId,
        agentMemberId: session.agentMemberId,
        body,
        parentMessageId,
      });
    } catch (err) {
      log.error({ err }, "agent session message post failed");
      return undefined;
    }
  }
}

/** Redact secret values from an error's message before logging. */
function redactError(err: unknown, redact: (s: string) => string): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redact(msg);
}

/**
 * #778: sleep for `ms`, resolving EARLY if `signal` aborts. Used for the inter-attempt retry backoff so a
 * Stop pressed between steps wakes the loop immediately (which then finalizes `canceled`) instead of
 * sleeping out the full delay. The timer is unref'd so it never keeps the event loop alive, and the abort
 * listener is removed on every exit path so a long-lived signal accrues no leaked listeners.
 */
function delayUntilAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => done();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
