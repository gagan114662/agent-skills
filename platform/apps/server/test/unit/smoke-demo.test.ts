import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { runDemoSmoke, DONE_MARKER } from "../../src/runtime/smoke-demo.js";
import { FileConfigWorkspaceProvisioner, type WorkspaceProvisioner } from "../../src/config/workspace.js";
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

/** A no-IO workspace provisioner returning a fixed cwd — keeps fake-runtime tests hermetic. */
function fakeWorkspace(cwd: string): WorkspaceProvisioner {
  return { prepare: () => Promise.resolve({ cwd }) };
}

describe("runDemoSmoke (#166 — post-deploy demo-harness E2E smoke; #238 provisioning gate)", () => {
  it("passes when the session emits the done marker and exits 0", async () => {
    const res = await runDemoSmoke({
      runtime: fakeRuntime({ output: `working…\n${DONE_MARKER} 'x'\n`, result: { status: "completed", exitCode: 0 } }),
      workspace: fakeWorkspace("/tmp"),
    });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.sawMarker).toBe(true);
  });

  it("FAILS on a spawn error (exitCode=null) — the missing-bash signature, and says so", async () => {
    const res = await runDemoSmoke({
      runtime: fakeRuntime({ output: "", result: { status: "failed", exitCode: null } }),
      workspace: fakeWorkspace("/tmp"),
    });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBeNull();
    expect(res.reason.toLowerCase()).toContain("bash");
  });

  it("FAILS when runtime.start throws (no session at all)", async () => {
    const res = await runDemoSmoke({ runtime: fakeRuntime({ throwOnStart: true }), workspace: fakeWorkspace("/tmp") });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("runtime.start threw");
  });

  it("FAILS when the process exits 0 but produced no real output (incomplete)", async () => {
    const res = await runDemoSmoke({
      runtime: fakeRuntime({ output: "", result: { status: "completed", exitCode: 0 } }),
      workspace: fakeWorkspace("/tmp"),
    });
    expect(res.ok).toBe(false);
    expect(res.sawMarker).toBe(false);
  });

  it("FAILS and cancels the session when it hangs past the timeout", async () => {
    const cancelled = { value: false };
    const res = await runDemoSmoke({
      runtime: fakeRuntime({ output: "", result: "hang", cancelled }),
      workspace: fakeWorkspace("/tmp"),
      timeoutMs: 50,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("timeout");
    expect(cancelled.value).toBe(true);
  });

  it("FAILS (never spawns) when workspace provisioning throws — the #238 EACCES root, with an actionable reason", async () => {
    // The prod cause: the per-session mkdir under a root-owned workspace root throws EACCES BEFORE the
    // harness spawns. The smoke must catch this and abort the deploy — not let users hit exit n/a.
    const throwingWorkspace: WorkspaceProvisioner = {
      prepare: () => Promise.reject(new Error("EACCES: permission denied, mkdir '/app/.reload/workspaces/smoke-demo'")),
    };
    const res = await runDemoSmoke({ runtime: fakeRuntime({ result: { status: "completed", exitCode: 0 } }), workspace: throwingWorkspace });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBeNull();
    expect(res.reason.toLowerCase()).toContain("workspace provisioning failed");
    expect(res.reason).toContain("RELOAD_WORKSPACE_ROOT");
  });

  it("REAL end-to-end: PROVISIONS a per-session workspace then spawns the actual demo harness via bash and completes", async () => {
    // Exercises the true provision→spawn path the deploy gate protects: a real `mkdir <root>/<id>` under
    // a writable root, then `bash <abs script>` run FROM that provisioned cwd. Needs `bash` (every CI
    // host has it). A non-writable root would throw here, exactly like the prod EACCES.
    const baseDir = mkdtempSync(join(tmpdir(), "smoke-ws-"));
    try {
      const workspace = new FileConfigWorkspaceProvisioner({ baseDir });
      const res = await runDemoSmoke({ task: "unit-test smoke", timeoutMs: 15_000, workspace });
      expect(res.ok).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(res.sawMarker).toBe(true);
      // The per-session workspace dir was really created under the (writable) root.
      expect(existsSync(join(baseDir, ".reload", "workspaces", "smoke-demo"))).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
