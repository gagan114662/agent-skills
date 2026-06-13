import { describe, it, expect } from "vitest";
import { preflight, type PreflightDeps, type PreflightInput } from "../../src/runtime/preflight.js";

const base = (over: Partial<PreflightInput>): PreflightInput => ({
  profile: "dev",
  runtime: "local",
  harness: "demo",
  env: {},
  ...over,
});

describe("preflight — agent browser runtime checks (#174)", () => {
  it("adds NO browser checks when the browser is disabled (default posture unchanged)", () => {
    // bash is present (the local-runtime spawn target, #166); only the browser checks are under test.
    const report = preflight(base({}), { binaryAvailable: (n) => n === "bash", moduleResolvable: () => false });
    expect(report.checks.some((c) => c.name.startsWith("browser-"))).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("FAILS when the browser is enabled but 'playwright' is not installed (#166 lesson)", () => {
    const deps: PreflightDeps = { binaryAvailable: () => true, moduleResolvable: () => false };
    const report = preflight(base({ browserEnabled: true }), deps);
    const check = report.checks.find((c) => c.name === "browser-playwright");
    expect(check?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("passes (with a binary WARN) when playwright is installed but no chromium is on PATH", () => {
    // bash present, chromium absent: the only browser miss is the (non-blocking) binary WARN.
    const deps: PreflightDeps = { binaryAvailable: (n) => n === "bash", moduleResolvable: () => true };
    const report = preflight(base({ browserEnabled: true }), deps);
    expect(report.checks.find((c) => c.name === "browser-playwright")?.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "browser-binary")?.status).toBe("warn");
    expect(report.ok).toBe(true); // a warn never blocks
  });

  it("fully passes when playwright + a chromium binary are present", () => {
    const deps: PreflightDeps = { binaryAvailable: () => true, moduleResolvable: () => true };
    const report = preflight(base({ browserEnabled: true, env: { BROWSER_BIN: "/usr/bin/chromium" } }), deps);
    expect(report.checks.find((c) => c.name === "browser-binary")?.status).toBe("pass");
    expect(report.ok).toBe(true);
  });
});
