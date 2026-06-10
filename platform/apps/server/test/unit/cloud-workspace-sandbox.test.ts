import { describe, it, expect } from "vitest";
import { ProviderCloudWorkspaceSandbox } from "../../src/workspace/sandbox.js";
import type {
  SandboxCreateOpts,
  SandboxInstance,
  SandboxProvider,
} from "../../src/runtime/sandbox.js";
import type { OutputStream } from "../../src/runtime/types.js";

/** Fake microVM recording its snapshot/stop lifecycle — stands in for the Vercel SDK (no spend). */
class FakeSandbox implements SandboxInstance {
  readonly id = "sbx_cw";
  snapshots = 0;
  stops = 0;
  run(
    _c: string,
    _a: string[],
    _o: (s: OutputStream, c: string) => void,
  ): Promise<{ exitCode: number }> {
    return Promise.resolve({ exitCode: 0 });
  }
  snapshot(): Promise<string> {
    this.snapshots += 1;
    return Promise.resolve("snap-from-vm");
  }
  stop(): Promise<void> {
    this.stops += 1;
    return Promise.resolve();
  }
}

class FakeProvider implements SandboxProvider {
  creates: SandboxCreateOpts[] = [];
  constructor(private readonly sandbox: SandboxInstance) {}
  create(opts: SandboxCreateOpts): Promise<SandboxInstance> {
    this.creates.push(opts);
    return Promise.resolve(this.sandbox);
  }
}

const caps = { wallClockMs: 1000, idleMs: 500 };

describe("ProviderCloudWorkspaceSandbox (#82 — runtime-backed cloud sleep/wake)", () => {
  it("resume feeds the snapshot id into the next SandboxCreateOpts.snapshotId (+ configured source)", async () => {
    const provider = new FakeProvider(new FakeSandbox());
    const source = { url: "https://github.com/acme/app.git", revision: "main" };
    const sb = new ProviderCloudWorkspaceSandbox(provider, { caps, source });

    await sb.resume("cw_1", "snap-resume");

    expect(provider.creates).toHaveLength(1);
    expect(provider.creates[0].snapshotId).toBe("snap-resume");
    expect(provider.creates[0].source).toEqual(source);
  });

  it("resume from a null snapshot provisions a fresh sandbox (no resume key)", async () => {
    const provider = new FakeProvider(new FakeSandbox());
    const sb = new ProviderCloudWorkspaceSandbox(provider, { caps });
    await sb.resume("cw_1", null);
    expect(provider.creates[0].snapshotId).toBeUndefined();
  });

  it("snapshotAndStop snapshots then stops the live sandbox and returns its snapshot id", async () => {
    const vm = new FakeSandbox();
    const provider = new FakeProvider(vm);
    const sb = new ProviderCloudWorkspaceSandbox(provider, { caps });

    await sb.resume("cw_1", null);
    const snapshotId = await sb.snapshotAndStop("cw_1");

    expect(snapshotId).toBe("snap-from-vm");
    expect(vm.snapshots).toBe(1);
    expect(vm.stops).toBe(1);
  });

  it("snapshotAndStop returns null when no sandbox is live for the workspace", async () => {
    const provider = new FakeProvider(new FakeSandbox());
    const sb = new ProviderCloudWorkspaceSandbox(provider, { caps });
    expect(await sb.snapshotAndStop("cw_unknown")).toBeNull();
    expect(provider.creates).toHaveLength(0);
  });

  it("resume is idempotent — a second resume does not provision a duplicate sandbox", async () => {
    const provider = new FakeProvider(new FakeSandbox());
    const sb = new ProviderCloudWorkspaceSandbox(provider, { caps });
    await sb.resume("cw_1", "snap-a");
    await sb.resume("cw_1", "snap-b");
    expect(provider.creates).toHaveLength(1);
  });
});
