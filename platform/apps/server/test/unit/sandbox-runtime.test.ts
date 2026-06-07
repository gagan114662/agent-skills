import { describe, it, expect } from "vitest";
import { SandboxRuntime } from "../../src/runtime/sandbox.js";
import type {
  SandboxCreateOpts,
  SandboxInstance,
  SandboxProvider,
} from "../../src/runtime/sandbox.js";
import type { AgentJob, OutputStream } from "../../src/runtime/types.js";

/** A fake sandbox that records its lifecycle calls — stands in for the Vercel SDK (no spend). */
class FakeSandbox implements SandboxInstance {
  readonly id = "sbx_test";
  snapshots = 0;
  stops = 0;
  private resolveRun?: (r: { exitCode: number }) => void;

  constructor(
    private readonly opts: {
      autoComplete: boolean;
      exitCode?: number;
      outputs?: [OutputStream, string][];
    },
  ) {}

  run(
    _command: string,
    _args: string[],
    onOutput: (stream: OutputStream, chunk: string) => void,
  ): Promise<{ exitCode: number }> {
    for (const [stream, chunk] of this.opts.outputs ?? []) onOutput(stream, chunk);
    if (this.opts.autoComplete) return Promise.resolve({ exitCode: this.opts.exitCode ?? 0 });
    return new Promise((resolve) => {
      this.resolveRun = resolve; // stays pending until stop() reaps it
    });
  }

  snapshot(): Promise<string> {
    this.snapshots += 1;
    // The snapshot is filesystem-only: it carries NO secret material, just an opaque id.
    return Promise.resolve("snap_xyz");
  }

  stop(): Promise<void> {
    this.stops += 1;
    this.resolveRun?.({ exitCode: 137 });
    return Promise.resolve();
  }
}

class FakeProvider implements SandboxProvider {
  lastCreate?: SandboxCreateOpts;
  constructor(private readonly sandbox: FakeSandbox) {}
  create(opts: SandboxCreateOpts): Promise<SandboxInstance> {
    this.lastCreate = opts;
    return Promise.resolve(this.sandbox);
  }
}

const job = (secrets: Record<string, string> = {}): AgentJob => ({
  sessionId: "sess_1",
  workspaceId: "ws_1",
  command: "bash",
  args: ["run.sh"],
  env: { AGENT_TASK: "do the thing" },
  secrets,
  caps: { wallClockMs: 10_000, idleMs: 5_000 },
});

const noopHooks = { onOutput: () => {} };

describe("SandboxRuntime (#25 — provision → run → snapshot → teardown, all mocked)", () => {
  it("on completion: streams output, snapshots, then stops (reaped)", async () => {
    const sandbox = new FakeSandbox({
      autoComplete: true,
      exitCode: 0,
      outputs: [["stdout", "hello\n"]],
    });
    const provider = new FakeProvider(sandbox);
    const seen: string[] = [];

    const running = await new SandboxRuntime(provider).start(job(), {
      onOutput: (_s, c) => seen.push(c),
    });
    const result = await running.wait();

    expect(seen).toEqual(["hello\n"]);
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.snapshotId).toBe("snap_xyz");
    expect(sandbox.snapshots).toBe(1);
    expect(sandbox.stops).toBe(1); // reaped — never left running
  });

  it("a non-zero exit is failed but the sandbox is still snapshotted + reaped", async () => {
    const sandbox = new FakeSandbox({ autoComplete: true, exitCode: 1 });
    const running = await new SandboxRuntime(new FakeProvider(sandbox)).start(job(), noopHooks);
    const result = await running.wait();
    expect(result.status).toBe("failed");
    expect(sandbox.stops).toBe(1);
  });

  it("cancel reaps a still-running sandbox exactly once", async () => {
    const sandbox = new FakeSandbox({ autoComplete: false });
    const running = await new SandboxRuntime(new FakeProvider(sandbox)).start(job(), noopHooks);

    await running.cancel("idle");
    const result = await running.wait();

    expect(result.status).toBe("idle_reaped");
    expect(sandbox.snapshots).toBe(1);
    expect(sandbox.stops).toBe(1);

    // idempotent: a second cancel does not snapshot/stop again
    await running.cancel("canceled");
    expect(sandbox.snapshots).toBe(1);
    expect(sandbox.stops).toBe(1);
  });

  it("injects per-tenant secrets at provision, and the snapshot carries none of them", async () => {
    const sandbox = new FakeSandbox({ autoComplete: true });
    const provider = new FakeProvider(sandbox);
    const running = await new SandboxRuntime(provider).start(
      job({ MY_SECRET: "sk-supersecret-value-123" }),
      noopHooks,
    );
    const result = await running.wait();

    // secret was injected into the sandbox at create time…
    expect(provider.lastCreate?.secrets).toEqual({ MY_SECRET: "sk-supersecret-value-123" });
    // …but the snapshot is just an opaque id — no secret material rides along.
    expect(result.snapshotId).toBe("snap_xyz");
    expect(result.snapshotId).not.toContain("sk-supersecret-value-123");
  });
});
