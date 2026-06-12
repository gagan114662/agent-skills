import type { CatalogEntry } from "../catalog/types.js";
import type { WorkflowFacts } from "./types.js";

/**
 * Build the pure facts bag a workflow's conditions evaluate against (#152, ADR-0152 §2). Kept separate
 * from the engine + the repo so it is unit-testable without a DB: given the workspace's catalog rows
 * (and an optional metrics bag), it produces a nested, dot-path-addressable object.
 *
 * Shape:
 *   catalog.total                 → total entries
 *   catalog.<kind>.count          → entries of that kind
 *   catalog.<kind>.active         → entries of that kind with status `active` (and per-status counts)
 *   metrics.<name>                → injected numeric/string metrics (empty by default — a documented seam)
 *
 * So a workflow author writes `catalog.site.active gte 1` or `metrics.signups gt 100`.
 */
export function buildCatalogFacts(
  entries: CatalogEntry[],
  metrics: Record<string, unknown> = {},
): WorkflowFacts {
  type Bucket = { count: number; active: number; inactive: number; pending: number; archived: number };
  const catalog: Record<string, unknown> = { total: entries.length };
  for (const e of entries) {
    const bucket: Bucket =
      (catalog[e.kind] as Bucket | undefined) ?? { count: 0, active: 0, inactive: 0, pending: 0, archived: 0 };
    bucket.count += 1;
    bucket[e.status] += 1;
    catalog[e.kind] = bucket;
  }
  return { catalog, metrics };
}
