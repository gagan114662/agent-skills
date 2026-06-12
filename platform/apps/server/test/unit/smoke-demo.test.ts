import { describe, it, expect } from "vitest";
import { runDemoSmoke, DONE_MARKER } from "../../src/runtime/smoke-demo.js";
import type { AgentRuntime, RunningSession, RuntimeResult, RuntimeHooks } from "../../src/runtime/types.js";

/**
 * Build a fake runtime that emits `output` then settles `wait()` with `result` ("hang" = never
 * settles, to exercise the timeout). `cancelled` lets a test assert the smoke tears a hung session down.
 */
function fakeRuntime(opts: {
  output?: string;
  result?: RuntimeResult | "hang";
  throwOnStart?: boolean;
  cancelled?: { value: boolean };
}): AgentRuntime {
  return {
    kind: "local",
    start(_job, hooks: RuntimeHooks): Promise<RunningSession> {
      if (opts.throwOnStart) return Promise.reject(new Error("spawn bash ENOENT"));
      if (opts.output) hooks.onOutput("stdout", opts.output);
      const session: RunningSession = {
        sessionId: "smoke-demo",
        wait: () =>
          opts.result === "hang"
            ? new Promise<RuntimeResult>(() => undefined)
            : Promise.resolve(opts.result as RuntimeResult),
        cancel: () => {
          if (opts.cancelled) opts.cancelled.value = true;
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    },
  };
}

describe("runDemoSmoke (#166 — post-deploy demo-harness E2E smoke)", () => {
  it("passes when the session emits the done marker and exits 0", async () => {
    const res = await runDemoSmoke({
      runtime: fakeRuntime({ output: `working…\n${DONE_MARKER} 'x'\n`, result: { status: "completed", exitCode: 0 } }),
    });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.sawMarker).toBe(true);
  });

  it("FAILS on a spawn error (exitCode=null) — the missing-bash signature, and says so", async () => {
    const res = await runDemoSmoke({
      runtime: fakeRuntime({ output: "", result: { status: "failed", exitCode: null } }),
    });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBeNull();
    expect(res.reason.toLowerCase()).toContain("bash");
  });

  it("FAILS when runtime.start throws (no session at all)", async () => {
    const res = await runDemoSmoke({ runtime: fakeRuntime({ throwOnStart: true }) });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("runtime.start threw");
  });

  it("FAILS when the process exits 0 but produced no real output (incomplete)", async () => {
    const res = await runDemoSmoke({
      runtime: fakeRuntime({ output: "", result: { status: "completed", exitCode: 0 } }),
    });
    expect(res.ok).toBe(false);
    expect(res.sawMarker).toBe(false);
  });

  it("FAILS and cancels the session when it hangs past the timeout", async () => {
    const cancelled = { value: false };
    const res = await runDemoSmoke({
      runtime: fakeRuntime({ output: "", result: "hang", cancelled }),
      timeoutMs: 50,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("timeout");
    expect(cancelled.value).toBe(true);
  });

  it("REAL end-to-end: spawns the actual demo harness via bash and completes", async () => {
    // Exercises the true spawn path the deploy gate protects — needs `bash` on the host (every dev/CI
    // host has it). Default cwd resolves to apps/server so scripts/agent-harness-demo.sh is found.
    const res = await runDemoSmoke({ task: "unit-test smoke", timeoutMs: 15_000 });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.sawMarker).toBe(true);
  });
});
