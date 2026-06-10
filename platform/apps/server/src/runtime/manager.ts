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
import type { WorkspaceProvisioner } from "../config/workspace.js";
import type { AgentRuntime, RunningSession, RuntimeResult } from "./types.js";
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
  }): Promise<AgentSession>;
  markRunning(id: string, sandboxId?: string): Promise<void>;
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
   * Optional harness-aware output decoder (#81): converts each raw stdout line into readable channel
   * text, keeping the parsed event for structured consumers. The `claude-code` harness emits
   * stream-json (one JSON event per line), so without this the channel shows raw JSON blobs. Absent
   * (and for the `demo` harness) → a verbatim pass-through, so default output is unchanged.
   */
  decodeOutput?: LineDecoder;
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
    // a row or make any runtime/cloud call — so a half-broken session never starts. The default
    // local/demo posture always passes; when no gate is wired (unit tests) this is a no-op.
    if (this.deps.preflight) {
      const report = this.deps.preflight();
      if (!report.ok) throw new PreflightError(report);
    }
    // Resolve the per-session harness (#50) BEFORE persisting or touching the runtime, so an invalid
    // kind is rejected without leaving a half-started session behind.
    const harness = this.resolveHarness(input.harness);
    const session = await this.deps.store.create({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentMemberId: input.agentMemberId,
      createdByMemberId: input.createdByMemberId,
      runtime: this.deps.runtime.kind,
      command: harness.spec.command,
      harness: harness.kind,
      caps: this.deps.caps,
      provider: input.selection?.provider ?? null,
      model: input.selection?.model ?? null,
      effort: input.selection?.effort ?? null,
      mode: input.selection?.mode ?? null,
    });
    const run = this.drive(session, input.task, {
      teamRunId: input.teamRunId,
      parentSpanId: input.parentSpanId,
      parentMessageId: input.parentMessageId,
      harnessEnv: input.harnessEnv,
      spec: harness.spec,
      decode: harness.decode,
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
    },
  ): Promise<AgentSessionOutcome> {
    // Secrets are resolved per tenant at provision and injected as runtime env only.
    const secrets = await this.deps.secrets.resolve(session.workspaceId);
    const redact = makeRedactor(secrets);

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
          caps: this.deps.caps,
        },
        {
          onOutput: (_stream, chunk) => {
            resetIdle();
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
    }

    if (buffer.trim()) emitLine(buffer); // flush a trailing partial line
    await postChain; // ensure every streamed line is persisted (in order) before the terminal message

    const resultText = tail.join("\n").slice(0, RESULT_MAX_CHARS);
    await this.safePost(session, `✅ session ${result.status} (exit ${result.exitCode ?? "n/a"})`, log);
    await this.deps.store.finalize(session.id, {
      status: result.status,
      exitCode: result.exitCode,
      result: resultText || null,
      snapshotId: result.snapshotId ?? null,
    });
    recordSessionEnded(this.deps.runtime.kind, result.status);
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
