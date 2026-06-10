import type { OutputStream } from "./types.js";
import type { SandboxCreateOpts, SandboxInstance, SandboxProvider } from "./sandbox.js";

/**
 * Production adapter mapping {@link SandboxProvider} onto the real Vercel Sandbox SDK
 * (`@vercel/sandbox` — https://vercel.com/docs/vercel-sandbox/sdk-reference). This is the
 * "close the laptop, agents keep working" backend: one ephemeral Firecracker microVM per session,
 * the same primitive Conductor's Cloud Workspaces are built on.
 *
 * The SDK is loaded via a *dynamic import behind a runtime variable* so it stays an OPTIONAL
 * dependency: the test/CI path injects a fake provider and never loads it, and the lockfile isn't
 * forced to carry the SDK. To use the `sandbox` backend:
 *   1. Install it:  pnpm --filter @reload/server add @vercel/sandbox
 *   2. Authenticate with EITHER a Vercel OIDC token (VERCEL_OIDC_TOKEN — recommended on Vercel,
 *      via `vercel link && vercel env pull`) OR, off-Vercel, an access token:
 *      VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID.
 *   3. Set AGENT_RUNTIME=sandbox.
 *
 * The SDK surface below is the exact slice we use, matching the published sdk-reference
 * (Sandbox.create / runCommand / Command.logs / Command.wait / snapshot / stop).
 */

/** A streamed log line from a running command (`Command.logs()` yields these). */
type LogChunk = { stream: "stdout" | "stderr"; data: string };

interface VercelCommand {
  /** Live structured log stream while the command runs. */
  logs(): AsyncIterable<LogChunk>;
  /** Resolves with the terminal exit code once the command finishes. */
  wait(): Promise<{ exitCode: number }>;
}

interface VercelSandbox {
  // The identifier's accessor name has drifted across SDK versions: docs say `sandboxId`, but
  // @vercel/sandbox 2.1.x exposes it as `name`. We read whichever is present.
  readonly sandboxId?: string;
  readonly name?: string;
  runCommand(params: {
    cmd: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    detached: true;
  }): Promise<VercelCommand>;
  /** Capture filesystem + packages for fast resume. Auto-stops the sandbox. */
  snapshot(opts?: { expiration?: number }): Promise<{ snapshotId: string }>;
  stop(opts?: { blocking?: boolean }): Promise<unknown>;
}

interface GitSourceArg {
  type: "git";
  url: string;
  revision?: string;
  depth?: number;
  username?: string;
  password?: string;
}
interface SnapshotSourceArg {
  type: "snapshot";
  snapshotId: string;
}

interface VercelSdk {
  Sandbox: {
    create(opts: {
      runtime?: string;
      source?: GitSourceArg | SnapshotSourceArg;
      resources?: { vcpus?: number };
      timeout?: number;
      env?: Record<string, string>;
      // Access-token auth for non-Vercel hosts; omitted values fall back to OIDC env.
      token?: string;
      teamId?: string;
      projectId?: string;
    }): Promise<VercelSandbox>;
  };
}

async function loadSdk(): Promise<VercelSdk> {
  const specifier = "@vercel/sandbox";
  try {
    return (await import(specifier)) as unknown as VercelSdk;
  } catch {
    throw new Error(
      "AGENT_RUNTIME=sandbox requires the '@vercel/sandbox' package. Install it " +
        "(pnpm --filter @reload/server add @vercel/sandbox) and authenticate with VERCEL_OIDC_TOKEN, " +
        "or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID — or run with AGENT_RUNTIME=local.",
    );
  }
}

class VercelSandboxInstance implements SandboxInstance {
  constructor(
    private readonly sandbox: VercelSandbox,
    /** Working dir for the harness inside the VM (#58/#51); undefined → the sandbox default. */
    private readonly cwd?: string,
  ) {}

  get id(): string {
    // `sandboxId` (docs) / `name` (SDK 2.1.x) / `id` (older) — read whichever the SDK provides.
    return this.sandbox.sandboxId ?? this.sandbox.name ?? (this.sandbox as { id?: string }).id ?? "";
  }

  async run(
    command: string,
    args: string[],
    onOutput: (stream: OutputStream, chunk: string) => void,
  ): Promise<{ exitCode: number }> {
    // Detached so we can stream `logs()` live (resets the orchestrator's idle timer) and still
    // await the terminal exit code via `wait()`.
    const cmd = await this.sandbox.runCommand({ cmd: command, args, cwd: this.cwd, detached: true });
    for await (const log of cmd.logs()) {
      onOutput(log.stream, log.data);
    }
    const { exitCode } = await cmd.wait();
    return { exitCode };
  }

  async snapshot(): Promise<string> {
    // snapshot() captures filesystem + packages and auto-stops the VM; a later stop() is a no-op.
    const { snapshotId } = await this.sandbox.snapshot();
    return snapshotId;
  }

  async stop(): Promise<void> {
    await this.sandbox.stop();
  }
}

/** The provider used when `AGENT_RUNTIME=sandbox`. Lazily loads the SDK on first `create`. */
export class VercelSandboxProvider implements SandboxProvider {
  async create(opts: SandboxCreateOpts): Promise<SandboxInstance> {
    const sdk = await loadSdk();

    // Source precedence: a fresh repo clone (agent-on-a-branch) > resume from a snapshot > empty.
    const source: GitSourceArg | SnapshotSourceArg | undefined = opts.source
      ? {
          type: "git",
          url: opts.source.url,
          revision: opts.source.revision,
          depth: opts.source.depth,
          username: opts.source.username,
          password: opts.source.password,
        }
      : opts.snapshotId
        ? { type: "snapshot", snapshotId: opts.snapshotId }
        : undefined;

    const sandbox = await sdk.Sandbox.create({
      runtime: process.env.VERCEL_SANDBOX_RUNTIME || "node24",
      source,
      resources: opts.vcpus ? { vcpus: opts.vcpus } : undefined,
      timeout: opts.caps.wallClockMs,
      // Secrets + non-secret env injected at provision; never written into a snapshot's filesystem.
      env: { ...opts.env, ...opts.secrets },
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    });
    return new VercelSandboxInstance(sandbox, opts.cwd);
  }
}
