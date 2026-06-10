import { describe, it, expect } from "vitest";
import { WarmPool } from "../../src/runtime/warm-pool.js";
import type {
  BindOpts,
  PrewarmOpts,
  PrewarmedSandbox,
  WarmableSandboxProvider,
} from "../../src/runtime/warm-pool.js";
import type { OutputStream, SandboxCreateOpts, SandboxInstance } from "../../src/runtime/sandbox.js";

// --- fakes ------------------------------------------------------------------

class FakeInstance implements SandboxInstance {
  constructor(
    readonly id: string,
    /** The secrets this instance was created/bound with — used to prove secrets arrive only at bind. */
    readonly boundSecrets: Record<string, string>,
  ) {}
  run(_c: string, _a: string[], _o: (s: OutputStream, c: string) => void): Promise<{ exitCode: number }> {
    return Promise.resolve({ exitCode: 0 });
  }
  snapshot(): Promise<string> {
    return Promise.resolve(`snap_${this.id}`);
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

class FakePrewarm implements PrewarmedSandbox {
  bound = false;
  discarded = false;
  constructor(
    readonly id: string,
    readonly region: string | undefined,
  ) {}
  bind(opts: BindOpts): Promise<SandboxInstance> {
    this.bound = true;
    return Promise.resolve(new FakeInstance(`bound_${this.id}`, opts.secrets));
  }
  discard(): Promise<void> {
    this.discarded = true;
    return Promise.resolve();
  }
}

class FakeProvider implements WarmableSandboxProvider {
  readonly prewarmed: FakePrewarm[] = [];
  readonly coldCreates: SandboxCreateOpts[] = [];
  private seq = 0;
  prewarm(opts: PrewarmOpts): Promise<PrewarmedSandbox> {
    const p = new FakePrewarm(`pw${++this.seq}`, opts.region);
    this.prewarmed.push(p);
    return Promise.resolve(p);
  }
  create(opts: SandboxCreateOpts): Promise<SandboxInstance> {
    this.coldCreates.push(opts);
    return Promise.resolve(new FakeInstance(`cold${++this.seq}`, opts.secrets));
  }
}

const createOpts = (over: Partial<SandboxCreateOpts> = {}): SandboxCreateOpts => ({
  sessionId: "sess",
  workspaceId: "ws1",
  env: { AGENT_TASK: "go" },
  secrets: { API_KEY: "sk-secret" },
  caps: { wallClockMs: 1000, idleMs: 1000 },
  ...over,
});

// --- tests ------------------------------------------------------------------

describe("WarmPool (#71 — snapshot-primed spin-up, secrets bound only at claim)", () => {
  it("warm() pre-provisions the buffer to size and a launch binds (no cold create)", async () => {
    const provider = new FakeProvider();
    const pool = new WarmPool({ provider, size: 2 });
    await pool.warm();
    expect(pool.available()).toBe(2);
    expect(provider.prewarmed.length).toBe(2);

    const instance = (await pool.create(createOpts())) as FakeInstance;
    expect(instance.id).toMatch(/^bound_/); // served from the pool, not cold-created
    expect(provider.coldCreates.length).toBe(0);
    expect(provider.prewarmed[0]?.bound).toBe(true);
  });

  it("binds the tenant's secrets at claim time — a prewarmed instance never holds them", async () => {
    const provider = new FakeProvider();
    const pool = new WarmPool({ provider, size: 1 });
    await pool.warm();
    const instance = (await pool.create(createOpts({ secrets: { TOKEN: "t0p" } }))) as FakeInstance;
    // secrets arrived via bind, proven by the bound instance carrying them
    expect(instance.boundSecrets).toEqual({ TOKEN: "t0p" });
    // the prewarm seam has no secrets channel at all (compile-time guarantee); the buffer is generic
  });

  it("cold-creates on a pool miss (empty buffer) and records the miss", async () => {
    const provider = new FakeProvider();
    let hits = 0;
    let misses = 0;
    const pool = new WarmPool({ provider, size: 0, onHit: () => hits++, onMiss: () => misses++ });
    const instance = (await pool.create(createOpts())) as FakeInstance;
    expect(instance.id).toMatch(/^cold/);
    expect(provider.coldCreates.length).toBe(1);
    expect(hits).toBe(0);
    expect(misses).toBe(1);
  });

  it("a snapshot resume bypasses the pool (a returning session resumes its own snapshot)", async () => {
    const provider = new FakeProvider();
    let hits = 0;
    const pool = new WarmPool({ provider, size: 2, onHit: () => hits++ });
    await pool.warm();
    const instance = (await pool.create(createOpts({ snapshotId: "snap_prev" }))) as FakeInstance;
    expect(instance.id).toMatch(/^cold/); // cold path honours the snapshotId
    expect(provider.coldCreates[0]?.snapshotId).toBe("snap_prev");
    expect(hits).toBe(0); // the warm buffer is untouched
    expect(pool.available()).toBe(2);
  });

  it("refills asynchronously after a claim, back up to size", async () => {
    const provider = new FakeProvider();
    let hits = 0;
    const pool = new WarmPool({ provider, size: 1, onHit: () => hits++ });
    await pool.warm();
    expect(pool.available()).toBe(1);
    await pool.create(createOpts()); // claim the one warm instance
    await pool.settle(); // let the background refill finish
    expect(hits).toBe(1);
    expect(pool.available()).toBe(1); // topped back up
    expect(provider.prewarmed.length).toBe(2); // one initial + one refill
  });

  it("keeps a separate buffer per region and binds from the matching region", async () => {
    const provider = new FakeProvider();
    const pool = new WarmPool({ provider, size: 1, regions: ["iad1", "sfo1"] });
    await pool.warm();
    expect(pool.available("iad1")).toBe(1);
    expect(pool.available("sfo1")).toBe(1);

    const instance = (await pool.create(createOpts({ region: "sfo1" }))) as FakeInstance;
    expect(instance.id).toMatch(/^bound_/);
    const sfoPrewarm = provider.prewarmed.find((p) => p.region === "sfo1");
    expect(sfoPrewarm?.bound).toBe(true);
    // the iad1 buffer is untouched
    expect(provider.prewarmed.find((p) => p.region === "iad1")?.bound).toBe(false);
  });

  it("drain() discards every buffered prewarm (clean shutdown)", async () => {
    const provider = new FakeProvider();
    const pool = new WarmPool({ provider, size: 2 });
    await pool.warm();
    await pool.drain();
    expect(provider.prewarmed.every((p) => p.discarded)).toBe(true);
    expect(pool.available()).toBe(0);
  });
});
