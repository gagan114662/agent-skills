import type {
  AgentJob,
  AgentRuntime,
  OutputStream,
  ResourceCaps,
  RunningSession,
  RuntimeHooks,
  RuntimeResult,
  TerminalReason,
} from "./types.js";
import { statusForReason } from "./types.js";

/**
 * Provider seam for the sandbox backend. The real Vercel adapter (`@vercel/sandbox`) implements
 * this behind a dynamic import (see ./vercel-provider.ts), so the SDK is an optional dependency
 * and the test/CI path never loads it — tests inject a fake provider and incur no cloud spend.
 */
export interface SandboxProvider {
  /** Provision (or resume from `snapshotId`) an isolated sandbox with secrets injected as env. */
  create(opts: SandboxCreateOpts): Promise<SandboxInstance>;
}

/**
 * Optional Git source cloned into the sandbox at provision time. Mirrors Conductor's model where
 * each agent works on an isolated branch of your codebase (`revision`). Credentials are used only
 * to clone a private repo and are never persisted into a snapshot.
 */
export interface SandboxGitSource {
  url: string;
  /** Branch, tag, or commit to check out. */
  revision?: string;
  /** Shallow-clone depth for large repos (faster spin-up). */
  depth?: number;
  username?: string;
  password?: string;
}

export interface SandboxCreateOpts {
  sessionId: string;
  workspaceId: string;
  /** Non-secret env. */
  env: Record<string, string>;
  /** Per-tenant secrets — injected as env only, NEVER written into a snapshot. */
  secrets: Record<string, string>;
  /** Resume key: a prior snapshot for fast spin-up, if any. */
  snapshotId?: string;
  /** Optional repo to clone into the sandbox (Conductor "agent on a branch" model). */
  source?: SandboxGitSource;
  /** Optional vCPU count for the microVM (defaults to the SDK default of 2). */
  vcpus?: number;
  /** Multi-region placement (#71): the region to provision in, chosen by the admission planner. */
  region?: string;
  caps: ResourceCaps;
}

export interface SandboxInstance {
  readonly id: string;
  /** Run the command; stream output via `onOutput`; resolve when it exits (or is stopped). */
  run(
    command: string,
    args: string[],
    onOutput: (stream: OutputStream, chunk: string) => void,
  ): Promise<{ exitCode: number }>;
  /** Capture a filesystem snapshot for fast resume. Returns the snapshot id. NO secrets. */
  snapshot(): Promise<string>;
  /** Stop + destroy the sandbox (reaping). Idempotent on the provider side. */
  stop(): Promise<void>;
}

/**
 * SandboxRuntime — one isolated sandbox per agent session (the trust boundary for untrusted
 * code). Lifecycle: provision (`provider.create`) → attach/run (`sandbox.run`) → snapshot
 * (`sandbox.snapshot`) → teardown (`sandbox.stop`, always, so nothing is left un-reaped).
 */
export class SandboxRuntime implements AgentRuntime {
  readonly kind = "sandbox" as const;

  constructor(private readonly provider: SandboxProvider) {}

  async start(job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession> {
    const sandbox = await this.provider.create({
      sessionId: job.sessionId,
      workspaceId: job.workspaceId,
      env: job.env,
      secrets: job.secrets,
      caps: job.caps,
    });
    const session = new SandboxSession(job.sessionId, sandbox);
    session.begin(job.command, job.args, hooks);
    return session;
  }
}

class SandboxSession implements RunningSession {
  readonly sandboxId: string;
  private forcedReason: TerminalReason | undefined;
  private tornDown = false;
  private resolveDone!: (r: RuntimeResult) => void;
  private readonly done: Promise<RuntimeResult>;

  constructor(
    readonly sessionId: string,
    private readonly sandbox: SandboxInstance,
  ) {
    this.sandboxId = sandbox.id;
    this.done = new Promise<RuntimeResult>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** Kick off the run and drive it to teardown. Called once by the runtime. */
  begin(command: string, args: string[], hooks: RuntimeHooks): void {
    const runPromise = this.sandbox.run(command, args, (stream, chunk) =>
      hooks.onOutput(stream, chunk),
    );
    void this.drive(runPromise);
  }

  private async drive(runPromise: Promise<{ exitCode: number }>): Promise<void> {
    let exitCode: number | null = null;
    let naturalReason: TerminalReason = "failed";
    try {
      const r = await runPromise;
      exitCode = r.exitCode;
      naturalReason = r.exitCode === 0 ? "completed" : "failed";
    } catch {
      naturalReason = "failed";
    }
    await this.teardown(this.forcedReason ?? naturalReason, exitCode);
  }

  /** Snapshot then stop the sandbox exactly once, resolving the terminal result. */
  private async teardown(reason: TerminalReason, exitCode: number | null): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    let snapshotId: string | undefined;
    try {
      snapshotId = await this.sandbox.snapshot();
    } catch {
      /* snapshot is best-effort; teardown must still reap */
    }
    try {
      await this.sandbox.stop();
    } catch {
      /* already gone */
    }
    this.resolveDone({ status: statusForReason(reason), exitCode, snapshotId });
  }

  wait(): Promise<RuntimeResult> {
    return this.done;
  }

  /** Reaper/explicit cancel: force teardown now, guaranteeing the sandbox is reaped. */
  async cancel(reason: TerminalReason): Promise<void> {
    this.forcedReason = reason;
    await this.teardown(reason, null);
  }
}
