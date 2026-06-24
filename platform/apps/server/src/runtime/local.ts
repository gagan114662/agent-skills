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
    const onStdout = (chunk: string): void => hooks.onOutput("stdout", chunk);
    const onStderr = (chunk: string): void => hooks.onOutput("stderr", chunk);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);

    const session = new LocalSession(job.sessionId, child, () => {
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
    });

    // #778: honor the hard-cancel signal directly — SIGKILL the process tree the instant Stop is pressed.
    // Belt-and-suspenders with SessionManager.cancel() (which also calls cancel("canceled")); a no-op when
    // the signal is absent (back-compat) or already torn down. Marked `canceled` so the exit reports it.
    if (job.signal) {
      const onAbort = (): void => {
        void session.cancel("canceled");
      };
      if (job.signal.aborted) onAbort();
      else job.signal.addEventListener("abort", onAbort, { once: true });
    }

    return Promise.resolve(session);
  }
}

class LocalSession implements RunningSession {
  /** Set by `cancel()` so the exit handler reports the reaper's reason, not a generic failure. */
  private forcedReason: TerminalReason | undefined;
  private readonly done: Promise<RuntimeResult>;
  private outputCleaned = false;

  constructor(
    readonly sessionId: string,
    private readonly child: ChildProcess,
    private readonly cleanupOutput: () => void,
  ) {
    this.done = new Promise<RuntimeResult>((resolve) => {
      let settled = false;
      const onExit = (code: number | null): void => settle(code);
      const onError = (): void => settle(null);
      const settle = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        this.cleanupOutputOnce();
        child.off("exit", onExit);
        child.off("error", onError);
        const reason: TerminalReason =
          this.forcedReason ?? (exitCode === 0 ? "completed" : "failed");
        resolve({ status: statusForReason(reason), exitCode });
      };
      child.on("exit", onExit);
      child.on("error", onError); // spawn failure → failed (no exit code)
    });
  }

  wait(): Promise<RuntimeResult> {
    return this.done;
  }

  cancel(reason: TerminalReason): Promise<void> {
    this.forcedReason = reason;
    this.cleanupOutputOnce();
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

  private cleanupOutputOnce(): void {
    if (this.outputCleaned) return;
    this.outputCleaned = true;
    this.cleanupOutput();
  }
}

/** Kill the child's whole process group; fall back to the pid; never throw if already gone. */
export function killTree(child: ChildProcess): void {
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
