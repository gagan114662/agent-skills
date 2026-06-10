import type { ResourceCaps } from "./types.js";
import type { SandboxCreateOpts, SandboxInstance, SandboxProvider } from "./sandbox.js";

/**
 * Warm pool (#71) — snapshot-primed fast spin-up. #25 cold-provisions a sandbox on every launch
 * (microVM boot + base image), which dominates spin-up latency. A warm pool keeps a buffer of
 * sandboxes that have already paid that cost, so a launch **binds** (fast) instead of
 * **cold-creates** (slow).
 *
 * **Security model:** a {@link PrewarmedSandbox} is provisioned with **no tenant secrets and no
 * task** — it is generic and safe to hold in a shared buffer. Tenant secrets + env are injected
 * only at {@link PrewarmedSandbox.bind | bind} time, producing a tenant-specific, short-lived
 * {@link SandboxInstance}. So a pooled instance can never leak a secret across tenants; this is the
 * security-correct warm-pool model (the `prewarm` seam has no secrets channel by construction).
 *
 * `WarmPool` **decorates** a {@link WarmableSandboxProvider} and itself `implements SandboxProvider`,
 * so it slots transparently in front of `SandboxRuntime` (the factory wraps the real provider when
 * `warmPoolSize > 0`). With `size = 0` it is a pass-through (always cold) — today's #25 behavior.
 */

/** Tenant env + secrets bound to a prewarmed sandbox at claim time (never before). */
export interface BindOpts {
  sessionId: string;
  workspaceId: string;
  env: Record<string, string>;
  /** Per-tenant secrets — injected ONLY here, never into the pooled prewarm. */
  secrets: Record<string, string>;
  caps: ResourceCaps;
}

/** What a prewarm needs: a region to provision in (secret-free — note the absence of secrets). */
export interface PrewarmOpts {
  region?: string;
}

/** A sandbox primed (boot + base image done) but carrying NO secrets and NO task. */
export interface PrewarmedSandbox {
  readonly id: string;
  readonly region: string | undefined;
  /** Inject env + secrets and return a runnable instance (the fast path). */
  bind(opts: BindOpts): Promise<SandboxInstance>;
  /** Discard an unclaimed prewarm (pool shrink / shutdown). Idempotent. */
  discard(): Promise<void>;
}

/** A {@link SandboxProvider} that can pre-provision secret-free sandboxes ahead of demand. */
export interface WarmableSandboxProvider extends SandboxProvider {
  prewarm(opts: PrewarmOpts): Promise<PrewarmedSandbox>;
}

export interface WarmPoolDeps {
  provider: WarmableSandboxProvider;
  /** Per-region buffer target. `0` = pool off (always cold-create — the #25 pass-through). */
  size: number;
  /** Regions to keep warm; empty → a single unlabelled buffer (single-region). */
  regions?: string[];
  /** Metric hook: a launch was served from the warm buffer. */
  onHit?: () => void;
  /** Metric hook: a launch cold-created (empty buffer or a snapshot resume). */
  onMiss?: () => void;
}

/** Buffer key for a region (undefined region → the unlabelled buffer). */
const keyOf = (region: string | undefined): string => region ?? "";

export class WarmPool implements SandboxProvider {
  private readonly buffers = new Map<string, PrewarmedSandbox[]>();
  /** In-flight background refills, so tests/shutdown can await a quiescent pool. */
  private readonly pending = new Set<Promise<void>>();
  /** Buffer keys to keep warm (the configured regions, or [""] for single-region). */
  private readonly keys: string[];

  constructor(private readonly deps: WarmPoolDeps) {
    this.keys = deps.regions && deps.regions.length > 0 ? deps.regions.map(keyOf) : [""];
    for (const k of this.keys) this.buffers.set(k, []);
  }

  /** Pre-fill every configured buffer up to `size`. Called at boot; awaitable. */
  async warm(): Promise<void> {
    await Promise.all(this.keys.map((k) => this.fill(k)));
  }

  /**
   * Provision a sandbox for a launch. A `snapshotId` resume bypasses the pool (a returning session
   * must resume its own snapshot); otherwise bind a buffered prewarm (hit) or cold-create (miss).
   * Either way the matching buffer is topped back up in the background.
   */
  async create(opts: SandboxCreateOpts): Promise<SandboxInstance> {
    if (opts.snapshotId) {
      this.deps.onMiss?.();
      return this.deps.provider.create(opts);
    }
    const key = keyOf(opts.region);
    const buffer = this.buffers.get(key);
    const prewarmed = buffer?.shift();
    if (prewarmed) {
      this.deps.onHit?.();
      const instance = await prewarmed.bind({
        sessionId: opts.sessionId,
        workspaceId: opts.workspaceId,
        env: opts.env,
        secrets: opts.secrets,
        caps: opts.caps,
      });
      this.track(this.fill(key));
      return instance;
    }
    this.deps.onMiss?.();
    this.track(this.fill(key));
    return this.deps.provider.create(opts);
  }

  /** How many warm instances are buffered for a region (introspection / tests). */
  available(region?: string): number {
    return this.buffers.get(keyOf(region))?.length ?? 0;
  }

  /** Await any in-flight background refills (tests / orderly checks). */
  async settle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /** Discard every buffered prewarm and stop refilling (clean shutdown). Idempotent. */
  async drain(): Promise<void> {
    await this.settle();
    const all: PrewarmedSandbox[] = [];
    for (const buffer of this.buffers.values()) all.push(...buffer.splice(0));
    await Promise.allSettled(all.map((p) => p.discard()));
  }

  /** Top one buffer up to `size`, one prewarm at a time (so concurrent fills don't overshoot). */
  private async fill(key: string): Promise<void> {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    while (buffer.length < this.deps.size) {
      const region = key === "" ? undefined : key;
      const prewarmed = await this.deps.provider.prewarm({ region });
      buffer.push(prewarmed);
    }
  }

  /** Register a background refill so `settle`/`drain` can await it; self-removing. */
  private track(p: Promise<void>): void {
    const wrapped = p.catch(() => {
      /* a refill failure must never crash the server; the next launch simply cold-creates */
    });
    this.pending.add(wrapped);
    void wrapped.finally(() => this.pending.delete(wrapped));
  }
}
