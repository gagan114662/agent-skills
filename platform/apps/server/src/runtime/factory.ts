import type { AgentEnv } from "../env.js";
import type { AgentRuntime } from "./types.js";
import { LocalRuntime } from "./local.js";
import { SandboxRuntime, type SandboxProvider } from "./sandbox.js";
import { VercelSandboxProvider } from "./vercel-provider.js";

/**
 * Select the AgentRuntime backend from config (#25). `local` is the default so tests/CI need no
 * cloud. A `SandboxProvider` can be injected (tests pass a fake — no real Vercel spend); when
 * omitted, the `sandbox` backend uses the real Vercel adapter (loaded lazily on first use).
 */
export function createRuntime(env: AgentEnv, sandboxProvider?: SandboxProvider): AgentRuntime {
  if (env.runtime === "sandbox") {
    // #83: thread the configured git source (SANDBOX_REPO_URL/REVISION) so each session's sandbox
    // clones the repo (agent-on-a-branch) instead of provisioning empty.
    return new SandboxRuntime(sandboxProvider ?? new VercelSandboxProvider(), {
      source: env.sandboxSource,
    });
  }
  return new LocalRuntime();
}
