import { spawn, type ChildProcess } from "node:child_process";
import type {
  AgentJob,
  AgentRuntime,
  RunningSession,
  RuntimeHooks,
  RuntimeResult,
  TerminalReason,
} from "./types.js";
import { statusForReason } from "./types.js";

/**
 * LocalRuntime — runs a trusted harness command as a host child process. This is the default
 * backend (`AGENT_RUNTIME=local`) so tests/CI need no cloud. It runs on the developer's own
 * machine; the *isolation boundary for untrusted code is SandboxRuntime*, not this one.
 *
 * Secrets are merged into the child's env at provision and are never persisted. The process is
 * spawned detached (its own process group) so cancel/teardown can kill the whole tree.
 */
export class LocalRuntime implements AgentRuntime {
  readonly kind = "local" as const;

  start(job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession> {
    const child = spawn(job.command, job.args, {
      // #58: run in the per-session workspace when one was provisioned (else inherit server cwd).
      cwd: job.cwd,
      env: { ...process.env, ...job.env, ...job.secrets },
      detached: true,
      // stdin is a pipe so steering (#53) can inject guidance into the live process. Harmless for
      // harnesses that don't read it (`claude -p` takes its prompt from argv; the `demo` harness
      // ignores stdin) — only a steerable harness consumes it.
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => hooks.onOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => hooks.onOutput("stderr", chunk));

    return Promise.resolve(new LocalSession(job.sessionId, child));
  }
}

class LocalSession implements RunningSession {
  /** Set by `cancel()` so the exit handler reports the reaper's reason, not a generic failure. */
  private forcedReason: TerminalReason | undefined;
  private readonly done: Promise<RuntimeResult>;

  constructor(
    readonly sessionId: string,
    private readonly child: ChildProcess,
  ) {
    this.done = new Promise<RuntimeResult>((resolve) => {
      const settle = (exitCode: number | null): void => {
        const reason: TerminalReason =
          this.forcedReason ?? (exitCode === 0 ? "completed" : "failed");
        resolve({ status: statusForReason(reason), exitCode });
      };
      child.on("exit", (code) => settle(code));
      child.on("error", () => settle(null)); // spawn failure → failed (no exit code)
    });
  }

  wait(): Promise<RuntimeResult> {
    return this.done;
  }

  cancel(reason: TerminalReason): Promise<void> {
    this.forcedReason = reason;
    killTree(this.child);
    return Promise.resolve();
  }

  /**
   * Steering (#53): write one guidance line to the harness stdin. Best-effort — if the process has
   * exited or its stdin is closed, the write is swallowed (the channel still records the steer).
   */
  steer(text: string): Promise<void> {
    try {
      this.child.stdin?.write(`${text}\n`);
    } catch {
      /* stdin closed / process gone — never throw from steering */
    }
    return Promise.resolve();
  }
}

/** Kill the child's whole process group; fall back to the pid; never throw if already gone. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }
}
