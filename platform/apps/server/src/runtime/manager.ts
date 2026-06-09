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
import type { SecretsResolver } from "./secrets-resolver.js";
import type { WorkspaceProvisioner } from "../config/workspace.js";
import type { AgentRuntime, RunningSession, RuntimeResult } from "./types.js";
import { noopTracer, type AgentSessionOutcome, type AgentTracer } from "../observability/tracing.js";

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
  /** The trusted harness command run for every session (never client-supplied). */
  harness: { command: string; args: string[] };
  caps: ResourceCaps;
  logger: SessionLogger;
  /** Optional observability seam: traces each session as a span. Defaults to a no-op. */
  tracer?: AgentTracer;
  /**
   * Optional workspace seam (#58): prepares a per-session working dir + copies files-to-copy into
   * it before the runtime starts. When absent, the harness inherits the server cwd (#25 behavior).
   */
  workspace?: WorkspaceProvisioner;
}

export interface LaunchInput {
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
  createdByMemberId: string;
  /** The user's task/prompt — passed to the harness as data (env), never as a command. */
  task: string;
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

  /** Persist + start a session, returning immediately. The run continues server-side. */
  async launch(input: LaunchInput): Promise<AgentSession> {
    const session = await this.deps.store.create({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentMemberId: input.agentMemberId,
      createdByMemberId: input.createdByMemberId,
      runtime: this.deps.runtime.kind,
      command: this.deps.harness.command,
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
    }).catch(() => {
      /* drive() never throws — terminal failures are persisted as `failed` */
    });
    this.runs.set(session.id, run);
    void run.finally(() => this.runs.delete(session.id));
    return session;
  }

  /** Cancel a running session (idempotent; no-op if already terminal). */
  async cancel(id: string): Promise<boolean> {
    const running = this.running.get(id);
    if (!running) return false;
    await running.cancel("canceled");
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
    } = {},
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
        }),
    );
  }

  /** The driven session lifecycle (provision -> run -> finalize); returns a trace-friendly outcome. */
  private async runSession(
    session: AgentSession,
    task: string,
    log: SessionLogger,
    opts: { parentMessageId?: string; harnessEnv?: Record<string, string> } = {},
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

    // Stream state: line-buffer output, keep a redacted tail for the result.
    let buffer = "";
    const tail: string[] = [];
    const emitLine = (line: string): void => {
      const clean = redact(line).trimEnd();
      if (!clean) return;
      tail.push(clean);
      if (tail.length > RESULT_TAIL_LINES) tail.shift();
      void this.safePost(session, clean, log, parentMessageId);
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
          command: this.deps.harness.command,
          args: this.deps.harness.args,
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
