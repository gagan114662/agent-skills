/**
 * Relevant-context ranking (issue #16, ADR-0016) — the pure core of "what memories should an
 * agent load for this task". Kept side-effect-free so it is unit-testable without a database;
 * the repo supplies the three candidate buckets, this orders + dedups + drops stale.
 */

/** A candidate node, reduced to what ranking needs (matches MemoryNode's relevant fields). */
export interface ContextCandidate {
  id: string;
  type: string;
  content: { text: string } & Record<string, unknown>;
  entity: string | null;
  /** set ⇒ the node has been superseded (stale) and is excluded unless explicitly asked for. */
  supersededByMemoryId: string | null;
}

/** A ranked context entry: the node plus *why* it surfaced. */
export interface ContextEntry extends ContextCandidate {
  reason: "linked" | "neighbor" | "label-match";
}

export interface ContextBuckets {
  /** memories directly linked to the task (strongest signal). */
  linked: ContextCandidate[];
  /** 1-hop graph neighbors of the linked set. */
  neighbors: ContextCandidate[];
  /** memories whose entity matches one of the task's labels. */
  labelMatches: ContextCandidate[];
}

/**
 * Merge the buckets in priority order (linked > neighbor > label-match), keep the first
 * occurrence of each node id, and — unless `includeStale` — drop superseded nodes. Deterministic:
 * order in == order out, so callers (and tests) can rely on a stable, explainable result.
 */
export function rankRelevantContext(
  buckets: ContextBuckets,
  opts: { includeStale?: boolean } = {},
): ContextEntry[] {
  const ordered: ContextEntry[] = [
    ...buckets.linked.map((n) => ({ ...n, reason: "linked" as const })),
    ...buckets.neighbors.map((n) => ({ ...n, reason: "neighbor" as const })),
    ...buckets.labelMatches.map((n) => ({ ...n, reason: "label-match" as const })),
  ];
  const seen = new Set<string>();
  const out: ContextEntry[] = [];
  for (const entry of ordered) {
    if (seen.has(entry.id)) continue;
    if (!opts.includeStale && entry.supersededByMemoryId !== null) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}
