/**
 * Shared memory graph config (issue #585). Deliberately **self-contained**: the master switch and the recall
 * freshness window are read directly from the process environment, so this feature adds NO edits to the
 * shared `config/schema.ts` barrel — keeping the #585 change set free of parallel-merge conflicts with
 * sibling branches.
 *
 * Default **ON** with a safe behavior. Unlike a money/irreversible gate (which defaults OFF and inert), the
 * memory graph is purely additive and advisory: it surfaces prior work and flags contradictions, but it
 * never blocks an action on its own. The useful default for an always-helpful shared world model is enabled,
 * so the value lands without per-deployment wiring. Set `MEMORY_GRAPH_ENABLED=0` to make the module inert
 * (recall returns nothing, writes are no-ops, conflict checks return empty) for a deployment that wants it off.
 */

/** A node older than this is "stale" and is NOT returned by recall as reusable prior work. */
export const DEFAULT_RECALL_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface MemoryGraphCaps {
  /** Master switch for the graph. ON by default (additive, advisory feature). */
  enabled: boolean;
  /** Recall only returns prior work updated within this many ms; older nodes stay in the graph but aren't surfaced. */
  recallFreshnessMs: number;
}

export const MEMORY_GRAPH_DEFAULTS: MemoryGraphCaps = {
  enabled: true,
  recallFreshnessMs: DEFAULT_RECALL_FRESHNESS_MS,
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

/** Parse a positive-integer ms env value; a missing/invalid/non-positive value keeps the default. */
function envFreshnessMs(raw: string | undefined): number {
  if (raw === undefined) return MEMORY_GRAPH_DEFAULTS.recallFreshnessMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return MEMORY_GRAPH_DEFAULTS.recallFreshnessMs;
  return Math.trunc(n);
}

/** Resolve the memory-graph caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveMemoryGraphCaps(env: NodeJS.ProcessEnv = process.env): MemoryGraphCaps {
  return {
    enabled: envFlag(env.MEMORY_GRAPH_ENABLED, MEMORY_GRAPH_DEFAULTS.enabled),
    recallFreshnessMs: envFreshnessMs(env.MEMORY_GRAPH_RECALL_FRESHNESS_MS),
  };
}
