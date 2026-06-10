import type { AgentEnv } from "../env.js";
import { recordWarmHit, recordWarmMiss } from "../observability/metrics.js";
import type { AgentRuntime } from "./types.js";
import { LocalRuntime } from "./local.js";
import { SandboxRuntime, type SandboxProvider } from "./sandbox.js";
import { VercelSandboxProvider } from "./vercel-provider.js";
import { WarmPool, type WarmableSandboxProvider } from "./warm-pool.js";

/** Warm-pool wiring options (#71): per-region buffer size + the regions to keep warm. */
export interface WarmPoolOptions {
  size: number;
  regions?: string[];
}

/** A provider is warmable when it can pre-provision secret-free sandboxes (`prewarm`). */
function isWarmable(p: SandboxProvider): p is WarmableSandboxProvider {
  return typeof (p as Partial<WarmableSandboxProvider>).prewarm === "function";
}

/**
 * Select the AgentRuntime backend from config (#25). `local` is the default so tests/CI need no
 * cloud. A `SandboxProvider` can be injected (tests pass a fake — no real Vercel spend); when
 * omitted, the `sandbox` backend uses the real Vercel adapter (loaded lazily on first use).
 *
 * Warm pool (#71): when `warmPool.size > 0` AND the provider is warmable, the provider is wrapped
 * in a {@link WarmPool} so launches bind from a pre-provisioned buffer instead of cold-creating.
 * The default Vercel adapter is not warmable yet (a documented follow-up — real microVM prewarm),
 * so production stays cold until then; the mechanism + tests ship now, behind the seam, with no
 * cloud spend — exactly as #25 left real Vercel calls behind a provider.
 */
export function createRuntime(
  env: AgentEnv,
  sandboxProvider?: SandboxProvider,
  warmPool?: WarmPoolOptions,
): AgentRuntime {
  if (env.runtime === "sandbox") {
    const provider = sandboxProvider ?? new VercelSandboxProvider();
    if (warmPool && warmPool.size > 0 && isWarmable(provider)) {
      return new SandboxRuntime(
        new WarmPool({
          provider,
          size: warmPool.size,
          regions: warmPool.regions,
          onHit: recordWarmHit,
          onMiss: recordWarmMiss,
        }),
      );
    }
    return new SandboxRuntime(provider);
  }
  return new LocalRuntime();
}
