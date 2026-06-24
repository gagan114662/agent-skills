import { describe, it, expect } from "vitest";
import { createDeployProvider } from "../../src/deploy/factory.js";
import { DryRunDeployProvider } from "../../src/deploy/dry-run-provider.js";
import { VercelDeployProvider } from "../../src/deploy/vercel-provider.js";

/**
 * Provider selection (#73), mirroring createRuntime (#25). `dryrun` is the default so tests/CI/the
 * demo never spend; `vercel` returns the real adapter WITHOUT loading the SDK (lazy on first deploy).
 */
describe("createDeployProvider (#73 — backend selection)", () => {
  it("defaults to the no-spend dry-run provider", () => {
    const provider = createDeployProvider({ provider: "dryrun", monitorIntervalMs: 0 });
    expect(provider).toBeInstanceOf(DryRunDeployProvider);
    expect(provider.kind).toBe("dryrun");
  });

  it("selects the Vercel adapter when configured, without loading the SDK", () => {
    const provider = createDeployProvider(
      { provider: "vercel", monitorIntervalMs: 0 },
      undefined,
      { VERCEL_TOKEN: "vercel_factory" },
    );
    expect(provider).toBeInstanceOf(VercelDeployProvider);
    expect(provider.kind).toBe("vercel");
  });

  it("uses an injected provider over the env selection (test seam)", () => {
    const injected = new DryRunDeployProvider();
    const provider = createDeployProvider({ provider: "vercel", monitorIntervalMs: 0 }, injected);
    expect(provider).toBe(injected);
  });
});
