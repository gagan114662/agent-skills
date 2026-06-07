import type { ResourceCaps, RuntimeKind, SessionStatus } from "../db/repositories/agent-sessions.js";

export type { ResourceCaps, RuntimeKind, SessionStatus };

/**
 * AgentRuntime — the model-agnostic execution layer for issue #25 (ADR-0025).
 *
 * A runtime knows how to run *a command* (a trusted agent harness) and stream its output; it
 * does NOT know which model/harness is inside (Claude, Codex, …). Two backends implement it:
 *   - LocalRuntime   — a host child process (dev/test default; no cloud).
 *   - SandboxRuntime — a Vercel Sandbox per session (the isolation boundary for untrusted code).
 *
 * The lifecycle (provision → attach → run → snapshot/idle → teardown) lives inside `start()` and
 * the returned `RunningSession`: `start` provisions + attaches + begins running, `wait()` resolves
 * at teardown with the terminal result, and `cancel()` forces teardown (used by the reaper).
 */
export interface AgentRuntime {
  readonly kind: RuntimeKind;
  start(job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession>;
}

/** Everything a runtime needs to provision and run one session. */
export interface AgentJob {
  /** Session id — also the snapshot/sandbox key, so a returning agent resumes fast. */
  sessionId: string;
  /** Tenant the session belongs to; scopes isolation + secret resolution. */
  workspaceId: string;
  /** The trusted harness command + args. NEVER arbitrary client input. */
  command: string;
  args: string[];
  /** Non-secret environment (e.g. the task/prompt as data). */
  env: Record<string, string>;
  /**
   * Per-tenant secrets injected at provision time as runtime env. These are NEVER written to a
   * snapshot and NEVER logged; the SessionManager redacts their values from streamed output too.
   */
  secrets: Record<string, string>;
  /** Hard resource + wall-clock caps for this session. */
  caps: ResourceCaps;
}

export type OutputStream = "stdout" | "stderr";

/** Callbacks the orchestrator supplies; the runtime invokes them as the session progresses. */
export interface RuntimeHooks {
  /** A chunk of live output. Resets the idle timer and is streamed into the channel. */
  onOutput(stream: OutputStream, chunk: string): void;
}

/** A handle to a session that is currently running on a runtime. */
export interface RunningSession {
  readonly sessionId: string;
  /** Provider sandbox id, if this backend provisions one (sandbox only). */
  readonly sandboxId?: string;
  /** Resolves at teardown with the terminal result. Never rejects — failures map to a status. */
  wait(): Promise<RuntimeResult>;
  /** Force teardown (idle/wall-clock reaper, explicit cancel). Idempotent. */
  cancel(reason: TerminalReason): Promise<void>;
}

/** Why a session ended — maps onto a persisted {@link SessionStatus}. */
export type TerminalReason = "completed" | "failed" | "timeout" | "idle" | "canceled";

export interface RuntimeResult {
  status: SessionStatus;
  exitCode: number | null;
  /** Snapshot id captured at teardown (sandbox backend). */
  snapshotId?: string;
}

/** Map a {@link TerminalReason} to its persisted {@link SessionStatus}. */
export function statusForReason(reason: TerminalReason): SessionStatus {
  switch (reason) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "timeout":
      return "timeout";
    case "idle":
      return "idle_reaped";
    case "canceled":
      return "canceled";
  }
}
