/**
 * Multi-region placement (#71). **Pure**: given a tenant's allowed regions, the current in-flight
 * load per region, and an optional preferred region, pick where a new session should run. No IO,
 * so it is unit-tested in isolation (the #17 pure-decision pattern). The chosen region flows
 * through `SandboxCreateOpts.region` and is persisted on the session row for audit.
 *
 * Strategy: **least-loaded allowed region**, ties broken by preference (the preferred region, then
 * allowed order), then region name (so the choice is deterministic). An empty allowed list yields
 * `undefined` — "unplaced", i.e. today's single-region #25 behavior.
 */

/** In-flight session count keyed by region. A missing region counts as zero. */
export type RegionLoad = Record<string, number>;

export function planRegion(
  allowed: string[],
  loadByRegion: RegionLoad,
  preferred?: string,
): string | undefined {
  if (allowed.length === 0) return undefined;

  // Preference rank: the preferred region (when allowed) ranks first, then allowed order.
  const order = preferred && allowed.includes(preferred) ? [preferred, ...allowed] : allowed;
  const rank = new Map<string, number>();
  for (const r of order) if (!rank.has(r)) rank.set(r, rank.size);

  return [...allowed].sort((a, b) => {
    const byLoad = (loadByRegion[a] ?? 0) - (loadByRegion[b] ?? 0);
    if (byLoad !== 0) return byLoad;
    const byRank = (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
    if (byRank !== 0) return byRank;
    return a < b ? -1 : a > b ? 1 : 0;
  })[0];
}
