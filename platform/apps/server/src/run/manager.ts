import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { RunState, RunStatus } from "@reload/shared";
import type { ResolvedConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import type { WorkspaceProvisioner } from "../config/workspace.js";
import { killTree } from "../runtime/local.js";
import { publishRunEvent } from "../realtime/bus.js";
import type { RunLogEvent, RunStatusEvent } from "../realtime/protocol.js";
import type { SessionLogger } from "../runtime/manager.js";
import { detectUrl } from "./detect.js";

/**
 * RunProcessManager (#56) — runs a session's app for the in-app preview. It is **separate** from the
 * SessionManager on purpose: SessionManager's contract is "run a harness to completion and finalize
 * the session row" (single-shot, teardown-on-exit), whereas a dev server is **long-lived** and must
 * never finalize the session. This manager reuses the proven `LocalRuntime` spawn primitive (detached
 * process group, piped stdio, `killTree`) directly, keeping the long-running, user-triggered process
 * off the safety-critical orchestrator — the same blast-radius discipline #51 used with `commitTurn`.
 *
 * State is **in-memory and ephemeral**: a run process is a child of the server and dies with it, so
 * there is no DB row to persist. One run process per session; starting twice is idempotent.
 */

/** Thrown when a session's resolved config declares no run command (route → 409). */
export class NoRunCommandError extends Error {
  constructor() {
    super("no run command configured");
    this.name = "NoRunCommandError";
  }
}

export interface StartRunInput {
  sessionId: string;
  workspaceId: string;
  channelId: string;
}

/** The injectable `spawn` signature (the subset this manager uses); defaults to `node:child_process`. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcess;

export interface RunProcessManagerDeps {
  /** Resolves the per-session working dir (the agent's worktree). Reuses the #58/#51 seam. */
  provisioner: WorkspaceProvisioner;
  /** Resolve the tenant's config (the run command lives here). Defaults to the real layered loader. */
  loadConfig?: (workspaceId: string) => ResolvedConfig;
  /** Publish run events to the channel bus. Defaults to the real Redis publisher. */
  publish?: (channelId: string, event: RunStatusEvent | RunLogEvent) => void;
  /** Process spawner (injectable for tests). Defaults to `node:child_process.spawn`. */
  spawn?: SpawnFn;
  logger?: SessionLogger;
  /** How many trailing output lines to retain per run (bounds memory from a chatty dev server). */
  maxLogLines?: number;
  /** How long to retain a terminal run state for polling after exit/stop/fail. */
  terminalRetentionMs?: number;
}

interface RunHandle {
  state: RunState;
  channelId: string;
  child?: ChildProcess;
  /** True once detection (or an explicit port) has resolved the preview URL. */
  resolved: boolean;
  cleanupTimer?: NodeJS.Timeout;
}

/** Statuses for which a run is still considered active (start is idempotent against these). */
const ACTIVE: ReadonlySet<RunStatus> = new Set<RunStatus>(["starting", "running"]);

const DEFAULT_MAX_LOG_LINES = 200;
const DEFAULT_TERMINAL_RETENTION_MS = 60_000;

export class RunProcessManager {
  private readonly runs = new Map<string, RunHandle>();
  private readonly provisioner: WorkspaceProvisioner;
  private readonly load: (workspaceId: string) => ResolvedConfig;
  private readonly publish: (channelId: string, event: RunStatusEvent | RunLogEvent) => void;
  private readonly spawn: SpawnFn;
  private readonly logger?: SessionLogger;
  private readonly maxLogLines: number;
  private readonly terminalRetentionMs: number;

  constructor(deps: RunProcessManagerDeps) {
    this.provisioner = deps.provisioner;
    this.load = deps.loadConfig ?? ((workspaceId) => loadConfig(workspaceId));
    this.publish =
      deps.publish ??
      ((channelId, event) => {
        publishRunEvent(channelId, event).catch(() => {
          /* best-effort realtime; the GET endpoint is the source of truth for run state */
        });
      });
    this.spawn = deps.spawn ?? (nodeSpawn as SpawnFn);
    this.logger = deps.logger;
    this.maxLogLines = deps.maxLogLines ?? DEFAULT_MAX_LOG_LINES;
    this.terminalRetentionMs = deps.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
  }

  /**
   * Start (or return the already-running) run process for a session. Throws {@link NoRunCommandError}
   * when the tenant configured no run command.
   */
  async start(input: StartRunInput): Promise<RunState> {
    const { sessionId, workspaceId, channelId } = input;
    const existing = this.runs.get(sessionId);
    if (existing && ACTIVE.has(existing.state.status)) return existing.state;

    const cfg = this.load(workspaceId);
    if (!cfg.run?.command) throw new NoRunCommandError();
    const runCfg = cfg.run;

    const prepared = await this.provisioner.prepare({ sessionId, workspaceId });

    const handle: RunHandle = {
      state: { sessionId, status: "starting", url: null, exitCode: null, error: null, logs: [] },
      channelId,
      resolved: false,
    };
    this.runs.set(sessionId, handle);
    this.emitStatus(handle);

    let child: ChildProcess;
    try {
      child = this.spawn("/bin/sh", ["-c", runCfg.command], {
        cwd: prepared.cwd,
        env: { ...process.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return this.fail(handle, err);
    }
    handle.child = child;

    // An explicit configured port short-circuits detection — trust it the moment the process is up.
    if (runCfg.port !== undefined) {
      this.markRunning(handle, `http://localhost:${runCfg.port}`);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // A SEPARATE line buffer per stream: stdout and stderr arrive on independent `data` events, so a
    // shared buffer would interleave their partial lines and corrupt the ready-banner detection.
    child.stdout?.on("data", this.lineSplitter(handle, runCfg.readyPattern));
    child.stderr?.on("data", this.lineSplitter(handle, runCfg.readyPattern));
    child.on("error", (err) => this.fail(handle, err));
    child.on("exit", (code) => {
      // A user `stop()` already moved the handle to `stopped`; don't overwrite it with `exited`.
      if (handle.state.status === "stopped" || handle.state.status === "failed") return;
      handle.state.status = "exited";
      handle.state.exitCode = code;
      this.emitStatus(handle);
      this.scheduleCleanup(handle);
    });

    return handle.state;
  }

  /** Current run state for a session, or an `idle` placeholder when none has started. */
  get(sessionId: string): RunState {
    const handle = this.runs.get(sessionId);
    if (!handle) return { sessionId, status: "idle", url: null, exitCode: null, error: null, logs: [] };
    return handle.state;
  }

  /** Stop a session's run process (kill the whole group). Idempotent; returns whether one was killed. */
  stop(sessionId: string): boolean {
    const handle = this.runs.get(sessionId);
    if (!handle || !ACTIVE.has(handle.state.status)) return false;
    if (handle.child) killTree(handle.child);
    handle.state.status = "stopped";
    this.emitStatus(handle);
    this.scheduleCleanup(handle);
    return true;
  }

  /** Kill every run process — called on server shutdown so no preview leaks past close. */
  shutdown(): void {
    for (const [sessionId, handle] of this.runs) {
      if (handle.cleanupTimer) clearTimeout(handle.cleanupTimer);
      this.stop(sessionId);
    }
    this.runs.clear();
  }

  // --- internals ---

  /** A stateful `data` handler with its own line buffer, so each stream splits lines independently. */
  private lineSplitter(handle: RunHandle, readyPattern?: string): (chunk: string) => void {
    let buffer = "";
    return (chunk: string): void => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        this.handleLine(handle, line, readyPattern);
      }
    };
  }

  private handleLine(handle: RunHandle, line: string, readyPattern?: string): void {
    this.appendLog(handle, line);
    if (!handle.resolved && handle.state.status === "starting") {
      const url = detectUrl(line, readyPattern);
      if (url) this.markRunning(handle, url);
    }
  }

  private appendLog(handle: RunHandle, line: string): void {
    handle.state.logs.push(line);
    if (handle.state.logs.length > this.maxLogLines) handle.state.logs.shift();
    const event: RunLogEvent = {
      type: "run_log",
      sessionId: handle.state.sessionId,
      channelId: handle.channelId,
      chunk: line,
    };
    this.publish(handle.channelId, event);
  }

  private markRunning(handle: RunHandle, url: string): void {
    handle.resolved = true;
    handle.state.status = "running";
    handle.state.url = url;
    this.emitStatus(handle);
  }

  private fail(handle: RunHandle, err: unknown): RunState {
    handle.state.status = "failed";
    handle.state.error = err instanceof Error ? err.message : String(err);
    this.logger?.warn({ sessionId: handle.state.sessionId, err: handle.state.error }, "run process failed");
    this.emitStatus(handle);
    this.scheduleCleanup(handle);
    return handle.state;
  }

  private emitStatus(handle: RunHandle): void {
    const event: RunStatusEvent = {
      type: "run_status",
      sessionId: handle.state.sessionId,
      channelId: handle.channelId,
      status: handle.state.status,
      url: handle.state.url,
      exitCode: handle.state.exitCode,
      error: handle.state.error,
    };
    this.publish(handle.channelId, event);
  }

  private scheduleCleanup(handle: RunHandle): void {
    if (handle.cleanupTimer) clearTimeout(handle.cleanupTimer);
    handle.child = undefined;
    handle.cleanupTimer = setTimeout(() => {
      if (this.runs.get(handle.state.sessionId) === handle) this.runs.delete(handle.state.sessionId);
    }, this.terminalRetentionMs);
    handle.cleanupTimer.unref?.();
  }
}
