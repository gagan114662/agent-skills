import type { RuntimeKind } from "../db/repositories/agent-sessions.js";
import type { HarnessKind } from "./harness.js";

/**
 * Posture profiles (#69, ADR-0038).
 *
 * A "profile" is a named preset of the deployment's execution posture — the pair of
 * `{ runtime, harness }` that, together, decide whether agents run locally with the echo `demo`
 * harness or in a Vercel sandbox with the real `claude-code` CLI. It exists so the whole cloud +
 * real-agent posture flips with ONE switch (`RELOAD_PROFILE`) instead of remembering to set both
 * `AGENT_RUNTIME` and `AGENT_HARNESS` in lockstep.
 *
 * Two profiles:
 *   - `dev`  = local + demo        → the default. No cloud spend, no model spend, no binaries; the
 *                                    posture CI and a fresh clone run on, unchanged from before #69.
 *   - `prod` = sandbox + claude-code → the productized cloud + real-agent posture, opt-in and gated
 *                                    by preflight ({@link ./preflight}).
 *
 * Precedence (resolved in `env.ts`): **explicit env (`AGENT_RUNTIME`/`AGENT_HARNESS`) > profile
 * preset > built-in default**. Because the default profile is `dev`, `loadEnv()` with no new vars
 * resolves to local/demo exactly as before — additive, not a behavior change.
 *
 * Whether to flip the *global default* to `prod` is deliberately deferred to #37 (e2e proof at
 * scale) and recorded in ADR-0038 — this module only makes the flip a single, safe switch.
 */
export type ProfileName = "dev" | "prod";

export interface Profile {
  runtime: RuntimeKind;
  harness: HarnessKind;
}

export const PROFILES: Record<ProfileName, Profile> = {
  dev: { runtime: "local", harness: "demo" },
  prod: { runtime: "sandbox", harness: "claude-code" },
};

/** The default posture: local/demo, so CI and a fresh clone need no cloud. */
export const DEFAULT_PROFILE: ProfileName = "dev";

/** Parse `RELOAD_PROFILE`; an unset/unknown value falls back to the safe `dev` default. */
export function parseProfile(value: string | undefined): ProfileName {
  return value === "prod" ? "prod" : "dev";
}

/** The `{ runtime, harness }` preset for a profile. */
export function profilePreset(name: ProfileName): Profile {
  return PROFILES[name];
}
