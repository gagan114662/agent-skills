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
  observeSpinup,
} from "../observability/metrics.js";
import { makeRedactor } from "./redact.js";
import type { LineDecoder } from "./stream-json.js";
import { isHarnessKind, type HarnessKind, type HarnessSpec } from "./harness.js";
import { PreflightError, type PreflightReport } from "./preflight.js";
import type { SecretsResolver } from "./secrets-resolver.js";
import { resolveEgressPolicy } from "./egress-allowlist.js";
import { loadConfig } from "../config/loader.js";
import type { WorkspaceProvisioner } from "../config/workspace.js";
import type { AdmissionController, AdmissionTicket } from "../scale/admission.js";
import type { UsageRecorder } from "../scale/usage.js";
import type { AgentRuntime, RunningSession, RuntimeResult } from "./types.js";
import type { AutoModelDecision, AutoModelResolver } from "./auto-model.js";
import { renderSessionOutcome, classifyFailure, failureCopy, isSuccess, type FailureReasonClass } from "./outcome.js";
import { noopTracer, type AgentSessionOutcome, type AgentTracer } from "../observability/tracing.js";

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

/** Persistence seam (real impl wraps the agent-sessions repository; tests inject a fake). */
export interface SessionStore {
  create(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    runtime: RuntimeKind;
    command: string;
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
  harnessOverrides?: (kind: HarnessKind) => { command: string; args: string[]; decode: LineDecoder };
  caps: ResourceCaps;
  logger: SessionLogger;
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
  }): Promise<void>;
  /**
   * Optional recovery sink (#238): called best-effort when a session COMPLETES cleanly — the
   * production-grounded proof the runtime is healthy again. Wired in production to resolve an open
   * agent-runtime spawn incident (#193) so a self-healing incident opened by a spawn cluster closes
   * itself once real sessions succeed (e.g. after the image is patched/redeployed). Absent → no-op; a
   * sink error never affects the already-finalized session.
   */
  onSessionRecovered?(event: { workspaceId: string; sessionId: string }): Promise<void>;
}

export interface LaunchInput {
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
  createdByMemberId: string;
  /** The user's task/prompt — passed to the harness as data (env), never as a command. */
  task: string;
  /**
   * Per-session coding-agent harness (#50): overrides the deployment default for THIS session.
   * Validated against the {@link HarnessKind} allowlist (invalid → {@link HarnessKindError}, mapped
   * to a 400) and persisted on the row. Omitted → the env default. Switching claude-code ↔ codex per
   * session works identically under LocalRuntime and SandboxRuntime.
   */
  harness?: HarnessKind;
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
    // Preflight gate (#69): fail fast on a misconfigured cloud/real-agent posture BEFORE we persist
    // a row, acquire an admission slot, or make any runtime/cloud call — so a half-broken session
    // never starts. The default local/demo posture always passes; no gate wired (unit tests) = no-op.
    if (this.deps.preflight) {
      const report = this.deps.preflight();
      if (!report.ok) throw new PreflightError(report);
    }
    // Resolve the per-session harness (#50) BEFORE acquiring an admission slot or persisting, so an
    // invalid kind is rejected without leaking a slot or leaving a half-started session behind.
    const harness = this.resolveHarness(input.harness);

    // Auto model-selection (convene-llm-gateway): when no explicit model is pinned, ask the routing
    // layer for the best model for this task. Done BEFORE admission so the (cheap, bounded, fail-open)
    // routing call doesn't hold a concurrency slot; it never throws (a failure degrades to the default).
    const auto = await this.maybeAutoSelectModel(input);
    const selectionRow = auto?.selectionRow ?? input.selection;
    const harnessEnv = auto ? auto.harnessEnv : input.harnessEnv;

    // #71: the admission chokepoint. A denied launch throws (kill switch / budget / capacity) BEFORE
    // any row is created — so the route maps it to 429/402 and the fleet never breaches a cap. When
    // no admission is wired this is a no-op and the session is unplaced (today's #25 behavior).
    const ticket = this.deps.admission
      ? await this.deps.admission.acquire(input.workspaceId)
      : undefined;

    let session: AgentSession;
    try {
      await this.deps.usage?.recordStart(input.workspaceId);
      session = await this.deps.store.create({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        agentMemberId: input.agentMemberId,
        createdByMemberId: input.createdByMemberId,
        runtime: this.deps.runtime.kind,
        command: harness.spec.command,
        harness: harness.kind,
        caps: this.deps.caps,
        provider: selectionRow?.provider ?? null,
        model: selectionRow?.model ?? null,
        effort: selectionRow?.effort ?? null,
        mode: selectionRow?.mode ?? null,
        // Auto-selection "why?" audit (convene-llm-gateway): the routing decision when auto-chosen.
        selectionMeta: auto?.decision ?? null,
        region: ticket?.region ?? null,
      });
    } catch (err) {
      // The slot was acquired but the session never started — free it so it isn't leaked.
      ticket?.release();
      throw err;
    }

    const run = this.drive(session, input.task, {
      teamRunId: input.teamRunId,
      parentSpanId: input.parentSpanId,
      parentMessageId: input.parentMessageId,
      harnessEnv,
      spec: harness.spec,
      decode: harness.decode,
      ticket,
    }).catch(() => {
      /* drive() never throws — terminal failures are persisted as `failed` */
    });
    this.runs.set(session.id, run);
    void run.finally(() => this.runs.delete(session.id));
    return session;
  }

  /**
   * Resolve the harness for a launch (#50): the env default, or a validated per-session override.
   * Returns the trusted spec + its output decoder + the kind to persist. Throws
   * {@link HarnessKindError} for an unknown kind, or an override the manager has no resolver for.
   */
  private resolveHarness(override?: HarnessKind): {
    kind: HarnessKind;
    spec: HarnessSpec;
    decode: LineDecoder;
  } {
    const defaultKind = this.deps.harnessKind ?? "demo";
    const defaultDecode: LineDecoder =
      this.deps.decodeOutput ?? ((line) => ({ display: [line], raw: null }));
    if (override === undefined || override === defaultKind) {
      return { kind: defaultKind, spec: this.deps.harness, decode: defaultDecode };
    }
    if (!isHarnessKind(override)) throw new HarnessKindError(override);
    if (!this.deps.harnessOverrides) {
      throw new HarnessKindError(override, "cannot be selected (no harness override resolver wired)");
    }
    const resolved = this.deps.harnessOverrides(override);
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
        selectionRow: { provider: ProviderKind; model: string; effort: EffortLevel; mode: SessionMode };
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

  /** Cancel a running session (idempotent; no-op if already terminal). */
  async cancel(id: string): Promise<boolean> {
    const running = this.running.get(id);
    if (!running) return false;
    await running.cancel("canceled");
    return true;
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
    },
  ): Promise<AgentSessionOutcome> {
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
    const emitLine = (line: string): void => {
      const decoded = decode(line);
      // Preserve the raw structured event for run-log / turns consumers — redacted before it lands in
      // the structured log so secrets never persist there either.
      if (decoded.raw !== null) {
        log.info({ event: redact(JSON.stringify(decoded.raw)) }, "agent stream event");
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
      // Fire-and-forget: a heartbeat hiccup must never fail an otherwise-healthy run.
      void this.deps.store.heartbeat(session.id).catch((err: unknown) => {
        log.error({ err }, "agent session heartbeat failed");
      });
    };

    // --- reaper: wall-clock + idle (no-output) timers ---
    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log.warn({ idleMs: this.deps.caps.idleMs }, "agent session idle-reaped");
        void runningRef?.cancel("idle");
      }, this.deps.caps.idleMs);
    };
    const wallTimer = setTimeout(() => {
      log.warn({ wallClockMs: this.deps.caps.wallClockMs }, "agent session wall-clock reaped");
      void runningRef?.cancel("timeout");
    }, this.deps.caps.wallClockMs);

    let runningRef: RunningSession | undefined;
    let result: RuntimeResult = { status: "failed", exitCode: null };
    // #71: the session's wall-clock lifetime is the compute-seconds we bill the tenant for.
    const runStart = Date.now();
    try {
      const provisionStart = Date.now();
      // #58: prepare the per-session workspace (copy files-to-copy in) when a provisioner is wired.
      const prepared = await this.deps.workspace?.prepare({
        sessionId: session.id,
        workspaceId: session.workspaceId,
      });
      const running = await this.deps.runtime.start(
        {
          sessionId: session.id,
          workspaceId: session.workspaceId,
          command: opts.spec.command,
          args: opts.spec.args,
          env: { AGENT_TASK: task, ...opts.harnessEnv },
          cwd: prepared?.cwd,
          secrets,
          // #71: the runtime provisions in the placed region (sandbox backend); local ignores it.
          region: opts.ticket?.region,
          // #151: the session's egress allowlist (undefined when OFF — unrestricted, #25 default).
          egress,
          caps: this.deps.caps,
        },
        {
          onOutput: (_stream, chunk) => {
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
        },
      );
      runningRef = running;
      this.running.set(session.id, running);
      observeSpinup(this.deps.runtime.kind, (Date.now() - provisionStart) / 1000);
      resetIdle();
      await this.deps.store.markRunning(session.id, running.sandboxId);

      result = await running.wait();
    } catch (err) {
      log.error({ err: redactError(err, redact) }, "agent session failed to run");
      result = { status: "failed", exitCode: null };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(wallTimer);
      this.running.delete(session.id);
      // #71: free the admission slot on every teardown path (success, failure, reap, cancel) so a
      // crashed/timed-out session never permanently consumes a tenant's concurrency budget.
      opts.ticket?.release();
    }

    if (buffer.trim()) emitLine(buffer); // flush a trailing partial line
    await postChain; // ensure every streamed line is persisted (in order) before the terminal message

    const resultText = tail.join("\n").slice(0, RESULT_MAX_CHARS);
    // #166: a green check ONLY on a clean completion. A failed/timed-out/canceled session renders a
    // failure mark + brand-voice reason (spawn/auth/timeout/budget/…) instead of the old lying
    // "✅ session failed (exit n/a)". `resultText` is already redacted; it's passed only to refine the
    // reason class (auth markers) and is never echoed back into the message.
    await this.safePost(
      session,
      renderSessionOutcome({ status: result.status, exitCode: result.exitCode, outputTail: resultText }),
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
      if (failureClass === "spawn" || failureClass === "error" || failureClass === "timeout") {
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
    // #71: account the compute consumed so a per-tenant budget can bite on the next launch. Pure
    // accounting — a recorder hiccup must never fail an already-finalized session.
    if (this.deps.usage) {
      const computeSeconds = Math.max(0, (Date.now() - runStart) / 1000);
      await this.deps.usage
        .recordCompute(session.workspaceId, computeSeconds)
        .catch((err: unknown) => log.error({ err }, "usage compute accounting failed"));
    }
    log.info({ status: result.status, snapshotId: result.snapshotId }, "agent session finalized");
    return { status: result.status, exitCode: result.exitCode ?? null, result: resultText || null };
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
