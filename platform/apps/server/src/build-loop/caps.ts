import type { BuildLoopConfig } from "../config/schema.js";
import { DEFAULT_PROTECTED_PATHS } from "./guardrails.js";

/**
 * Resolve the self-shipping-loop policy from the layered config (#58), applying hard defaults — mirrors
 * `flywheel/caps.ts` and `planning/caps.ts`. The loop is **default OFF** (`enabled: false`): a deployment
 * that sets no `buildLoop` section dispatches no builds, merges nothing, and the background tick is also
 * default-off (`BUILDLOOP_INTERVAL_MS = 0`). Even when enabled, auto-merge stays bounded by every cap here.
 */
export interface BuildLoopCaps {
  /** The self-shipping-loop flag. OFF by default. */
  enabled: boolean;
  /** Hard cap on concurrent in-flight build sessions per workspace (0 = never dispatch). */
  maxConcurrentBuilds: number;
  /** Max reviewer FAIL→revise rounds before a run escalates to the owner. */
  maxReviewRounds: number;
  /** Auto-merge size cap: max files changed (0 = no file cap). */
  maxDiffFiles: number;
  /** Auto-merge size cap: max total changed lines (0 = no line cap). */
  maxDiffLines: number;
  /** Protected paths that force human review (never auto-merge). */
  protectedPaths: readonly string[];
}

export const BUILDLOOP_DEFAULTS: BuildLoopCaps = {
  enabled: false,
  maxConcurrentBuilds: 1, // one self-shipping build in flight per workspace by default
  maxReviewRounds: 3, // three reviewer rounds, then a human
  maxDiffFiles: 50, // a self-shippable change is small; bigger needs a human
  maxDiffLines: 1500,
  protectedPaths: DEFAULT_PROTECTED_PATHS,
};

export function resolveBuildLoopCaps(cfg: BuildLoopConfig | undefined): BuildLoopCaps {
  // A configured allowlist REPLACES the defaults (so a managed tenant can widen/narrow deliberately);
  // an empty array means "no extra protected paths" only if explicitly set — undefined keeps defaults.
  const protectedPaths =
    cfg?.protectedPaths !== undefined ? cfg.protectedPaths : BUILDLOOP_DEFAULTS.protectedPaths;
  return {
    enabled: cfg?.enabled ?? BUILDLOOP_DEFAULTS.enabled,
    maxConcurrentBuilds: cfg?.maxConcurrentBuilds ?? BUILDLOOP_DEFAULTS.maxConcurrentBuilds,
    maxReviewRounds: cfg?.maxReviewRounds ?? BUILDLOOP_DEFAULTS.maxReviewRounds,
    maxDiffFiles: cfg?.maxDiffFiles ?? BUILDLOOP_DEFAULTS.maxDiffFiles,
    maxDiffLines: cfg?.maxDiffLines ?? BUILDLOOP_DEFAULTS.maxDiffLines,
    protectedPaths,
  };
}
