import type { OutputStream } from "./types.js";
import type { SandboxCreateOpts, SandboxInstance, SandboxProvider } from "./sandbox.js";

/**
 * Production adapter mapping {@link SandboxProvider} onto the Vercel Sandbox SDK
 * (`@vercel/sandbox`). It is loaded via a *dynamic import behind a runtime variable* so the SDK
 * stays an OPTIONAL dependency: tests/CI never reach this file (they inject a fake provider), and
 * the committed lockfile is not forced to carry the SDK. Install `@vercel/sandbox` and set
 * `VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` to use the `sandbox` backend in prod.
 *
 * The SDK surface is narrowed to exactly what we use; field names track the published SDK and may
 * need a bump per SDK version (documented in ADR-0025 as a follow-up risk).
 */

/** Minimal slice of the `@vercel/sandbox` module we depend on. */
interface VercelSdk {
  Sandbox: {
    create(opts: {
      timeout?: number;
      resources?: { memory?: number };
      source?: { type: "snapshot"; id: string };
      env?: Record<string, string>;
    }): Promise<VercelSandboxHandle>;
  };
}

interface VercelCommandHandle {
  stdout?: AsyncIterable<Uint8Array | string>;
  stderr?: AsyncIterable<Uint8Array | string>;
  wait(): Promise<{ exitCode: number }>;
}

interface VercelSandboxHandle {
  sandboxId: string;
  runCommand(opts: { cmd: string; args: string[] }): Promise<VercelCommandHandle>;
  createSnapshot?(): Promise<{ snapshotId: string }>;
  stop(): Promise<void>;
}

async function loadSdk(): Promise<VercelSdk> {
  const specifier = "@vercel/sandbox";
  try {
    return (await import(specifier)) as unknown as VercelSdk;
  } catch {
    throw new Error(
      "AGENT_RUNTIME=sandbox requires the '@vercel/sandbox' package. Install it and set " +
        "VERCEL_TOKEN / VERCEL_TEAM_ID / VERCEL_PROJECT_ID, or run with AGENT_RUNTIME=local.",
    );
  }
}

async function pump(
  iter: AsyncIterable<Uint8Array | string> | undefined,
  stream: OutputStream,
  onOutput: (stream: OutputStream, chunk: string) => void,
): Promise<void> {
  if (!iter) return;
  for await (const chunk of iter) {
    onOutput(stream, typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
}

class VercelSandboxInstance implements SandboxInstance {
  constructor(private readonly handle: VercelSandboxHandle) {}

  get id(): string {
    return this.handle.sandboxId;
  }

  async run(
    command: string,
    args: string[],
    onOutput: (stream: OutputStream, chunk: string) => void,
  ): Promise<{ exitCode: number }> {
    const cmd = await this.handle.runCommand({ cmd: command, args });
    // Stream both pipes concurrently; resolve with the exit code once the command finishes.
    await Promise.all([
      pump(cmd.stdout, "stdout", onOutput),
      pump(cmd.stderr, "stderr", onOutput),
    ]);
    return cmd.wait();
  }

  async snapshot(): Promise<string> {
    if (!this.handle.createSnapshot) {
      throw new Error("snapshots not supported by this SDK version");
    }
    const { snapshotId } = await this.handle.createSnapshot();
    return snapshotId;
  }

  stop(): Promise<void> {
    return this.handle.stop();
  }
}

/** The provider used when `AGENT_RUNTIME=sandbox`. Lazily loads the SDK on first `create`. */
export class VercelSandboxProvider implements SandboxProvider {
  async create(opts: SandboxCreateOpts): Promise<SandboxInstance> {
    const sdk = await loadSdk();
    // Secrets and non-secret env are both injected as env at provision — never written to disk,
    // so a later snapshot (filesystem only) cannot carry them.
    const handle = await sdk.Sandbox.create({
      timeout: opts.caps.wallClockMs,
      resources: opts.caps.memoryMb ? { memory: opts.caps.memoryMb } : undefined,
      source: opts.snapshotId ? { type: "snapshot", id: opts.snapshotId } : undefined,
      env: { ...opts.env, ...opts.secrets },
    });
    return new VercelSandboxInstance(handle);
  }
}
