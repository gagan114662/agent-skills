import { describe, it, expect } from "vitest";
import { DryRunInfraProvider } from "../../src/venture-deploy/dry-run-provider.js";
import { createInfraProvider } from "../../src/venture-deploy/factory.js";

function input(over: Partial<Parameters<DryRunInfraProvider["provisionTarget"]>[0]> = {}) {
  const logs: string[] = [];
  return {
    logs,
    arg: {
      workspaceId: "ws1",
      ventureId: "v1",
      slug: "acme",
      env: { NODE_ENV: "production" },
      secrets: {},
      onLog: (l: string) => logs.push(l),
      ...over,
    },
  };
}

describe("DryRunInfraProvider (#195: no-spend default)", () => {
  it("mints tenant-scoped preview + prod URLs and a project id", async () => {
    const p = new DryRunInfraProvider();
    const { arg } = input();
    const out = await p.provisionTarget(arg);
    expect(out.previewUrl).toBe("https://acme-preview.dryrun.reload.app");
    expect(out.prodUrl).toBe("https://acme.dryrun.reload.app");
    expect(out.projectId).toMatch(/^proj_acme_/);
    expect(out.estimatedSetupCents).toBe(0);
    expect(p.provisioned).toHaveLength(1);
  });

  it("is idempotent — re-provisioning the same slug returns the same project id", async () => {
    const p = new DryRunInfraProvider();
    const a = await p.provisionTarget(input().arg);
    const b = await p.provisionTarget(input().arg);
    expect(b.projectId).toBe(a.projectId);
  });

  it("echoes injected secrets to the log so the caller's redactor can be tested", async () => {
    const p = new DryRunInfraProvider();
    const { arg, logs } = input({ secrets: { API_KEY: "sk-test-123" } });
    await p.provisionTarget(arg);
    expect(logs.join("\n")).toContain("sk-test-123");
  });

  it("failNext forces one provisioning error, then resets", async () => {
    const p = new DryRunInfraProvider();
    p.failNext = "boom";
    await expect(p.provisionTarget(input().arg)).rejects.toThrow("boom");
    await expect(p.provisionTarget(input().arg)).resolves.toBeTruthy();
  });

  it("teardown is the reversibility proof — removes the project mapping", async () => {
    const p = new DryRunInfraProvider();
    const out = await p.provisionTarget(input().arg);
    await p.teardownTarget(out.projectId);
    expect(p.tornDown).toEqual([out.projectId]);
    // After teardown a fresh provision mints a NEW id (no stale mapping).
    const again = await p.provisionTarget(input().arg);
    expect(again.projectId).not.toBe(out.projectId);
  });
});

describe("createInfraProvider", () => {
  it("defaults to the dry-run backend", async () => {
    expect((await createInfraProvider("dryrun")).kind).toBe("dryrun");
  });

  it("returns an injected provider verbatim (test seam)", async () => {
    const fake = new DryRunInfraProvider();
    expect(await createInfraProvider("fly", fake)).toBe(fake);
  });

  it("lazily constructs the real fly adapter when selected", async () => {
    const p = await createInfraProvider("fly");
    expect(p.kind).toBe("fly");
  });

  it("lazily constructs the real vercel adapter when selected", async () => {
    const p = await createInfraProvider("vercel");
    expect(p.kind).toBe("vercel");
  });
});
