/**
 * Configuration for the dependency-aware scheduler (issue #590). Deliberately **self-contained** in the manner
 * of the #670 budget-governor and #674 content-guard modules: every tunable is read straight from the process
 * environment, so this feature adds NO edit to the shared `config/schema.ts` barrel and stays free of
 * parallel-merge conflicts with sibling branches.
 *
 * Default **OFF and inert**. Like a money/irreversible gate, this scheduler funnels outbound (publish/send/post)
 * actions, so it ships disabled: until a deployment sets `DEP_SCHEDULER_ENABLED=1`, the service hands out no
 * runnable work — `claimNext` returns null — so nothing executes through it. Planning and listing still work for
 * visibility. The pure planner is unaffected by the switch; the switch governs *execution*, not *analysis*.
 *
 * Which task kinds count as gates vs outbound is a GOVERNED constant ({@link GATE_KINDS} / {@link OUTBOUND_KINDS}),
 * not a deploy knob — reclassifying "publish" as harmless is a code review, not an env var. What IS env-tunable is
 * the operating envelope:
 *
 *   - `DEP_SCHEDULER_ENABLED`              — master execution switch. Default OFF.
 *   - `DEP_SCHEDULER_REQUIRE_GATE`         — fail-closed: outbound tasks must depend on a gate. Default ON.
 */

import type { TaskKind } from "./types.js";

/** Gate kinds: a dependency on one of these is satisfied ONLY when the gate is `approved`. */
export const GATE_KINDS: readonly TaskKind[] = ["review", "brand_check", "approval"];

/** Outbound kinds: the irreversible public actions #590 protects from running before content is approved. */
export const OUTBOUND_KINDS: readonly TaskKind[] = ["publish", "send", "post", "distribute"];

/** Whether `kind` is a content gate (review / brand_check / approval). */
export function isGateKind(kind: TaskKind): boolean {
  return GATE_KINDS.includes(kind);
}

/** Whether `kind` is an outbound distribution action (publish / send / post / distribute). */
export function isOutboundKind(kind: TaskKind): boolean {
  return OUTBOUND_KINDS.includes(kind);
}

/** The resolved operating envelope. */
export interface DependencySchedulerCaps {
  /** Master execution switch. OFF by default — the service hands out no runnable work until turned on. */
  enabled: boolean;
  /**
   * When true (default), an outbound task that declares NO gate dependency is fail-closed BLOCKED
   * (`ungated_outbound`) instead of runnable — so a builder that forgets the gate can never leak distribution.
   */
  requireGateForOutbound: boolean;
}

export const DEPENDENCY_SCHEDULER_DEFAULTS: DependencySchedulerCaps = {
  enabled: false,
  requireGateForOutbound: true,
};

/**
 * Parse a boolean-ish env flag with a default. `1`/`true`/`yes`/`on` ⇒ true, `0`/`false`/`no`/`off` ⇒ false
 * (case-insensitive); anything else (including unset) keeps `fallback`.
 */
function envFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

/** Resolve the scheduler caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveDependencySchedulerCaps(
  env: NodeJS.ProcessEnv = process.env,
): DependencySchedulerCaps {
  return {
    enabled: envFlag(env.DEP_SCHEDULER_ENABLED, DEPENDENCY_SCHEDULER_DEFAULTS.enabled),
    requireGateForOutbound: envFlag(
      env.DEP_SCHEDULER_REQUIRE_GATE,
      DEPENDENCY_SCHEDULER_DEFAULTS.requireGateForOutbound,
    ),
  };
}
