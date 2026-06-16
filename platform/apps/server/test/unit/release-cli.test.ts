import { describe, it, expect } from "vitest";
import { runReleaseGates } from "../../src/runtime/release-cli.js";
import type { SmokeResult } from "../../src/runtime/smoke-demo.js";
import type { PreflightReport } from "../../src/runtime/preflight.js";

const okPreflight = (): PreflightReport => ({ ok: true, checks: [] });
const okSmoke = (): Promise<SmokeResult> =>
  Promise.resolve({ ok: true, reason: "demo session completed", status: "completed", exitCode: 0, sawMarker: true });

/**
 * #273 — the Fly `[deploy] release_command` runs migrate → preflight → smoke on a one-off VM BEFORE any
 * traffic shifts. A non-zero exit aborts the rollout and the current release keeps serving — i.e. the
 * gate IS the automatic rollback. These tests pin the ordering + fail-fast guarantee with fakes (no DB,
 * no spawn), since the real path is exercised by the integration preflight + smoke-demo suites.
 */
describe("runReleaseGates (#273 — gated release: migrate → preflight → smoke, fail-fast = automatic rollback)", () => {
  it("passes when migrations, preflight and smoke all succeed", async () => {
    const res = await runReleaseGates({
      migrate: () => Promise.resolve(),
      preflight: okPreflight,
      smoke: okSmoke,
      log: () => undefined,
    });
    expect(res.ok).toBe(true);
    expect(res.failedGate).toBeUndefined();
  });

  it("ABORTS on a failed migration BEFORE preflight/smoke run — no traffic shift = automatic rollback", async () => {
    let preflightRan = false;
    let smokeRan = false;
    const res = await runReleaseGates({
      migrate: () => Promise.reject(new Error('relation "x" already exists')),
      preflight: () => {
        preflightRan = true;
        return okPreflight();
      },
      smoke: () => {
        smokeRan = true;
        return okSmoke();
      },
      log: () => undefined,
    });
    expect(res.ok).toBe(false);
    expect(res.failedGate).toBe("migrations");
    expect(preflightRan).toBe(false);
    expect(smokeRan).toBe(false);
    expect(res.reason.toLowerCase()).toContain("migration");
    expect(res.reason.toLowerCase()).toContain("rollback");
  });

  it("ABORTS on a failed preflight before the smoke runs", async () => {
    let smokeRan = false;
    const res = await runReleaseGates({
      migrate: () => Promise.resolve(),
      preflight: (): PreflightReport => ({
        ok: false,
        checks: [{ name: "git-binary", status: "fail", message: "git not found", remedy: "install git" }],
      }),
      smoke: () => {
        smokeRan = true;
        return okSmoke();
      },
      log: () => undefined,
    });
    expect(res.ok).toBe(false);
    expect(res.failedGate).toBe("preflight");
    expect(smokeRan).toBe(false);
    expect(res.reason).toContain("git-binary");
  });

  it("ABORTS when the smoke session fails end-to-end (e.g. a spawn error)", async () => {
    const res = await runReleaseGates({
      migrate: () => Promise.resolve(),
      preflight: okPreflight,
      smoke: () =>
        Promise.resolve({ ok: false, reason: "spawn bash ENOENT", status: "failed", exitCode: null, sawMarker: false }),
      log: () => undefined,
    });
    expect(res.ok).toBe(false);
    expect(res.failedGate).toBe("smoke");
  });
});
