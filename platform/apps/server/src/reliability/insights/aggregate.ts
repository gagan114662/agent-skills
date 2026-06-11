/**
 * Pure reliability insights (#148, ADR-0148) for the Founder Console pane — MTTR, incident frequency,
 * open count, and the noisiest components, computed off the existing `sre_incidents` rows. No IO, no
 * clock: `now` is supplied, so the windows are deterministic and unit-tested.
 */

/** The slice of an incident row the insights need (structural — any `IncidentRecord` satisfies it). */
export interface InsightIncident {
  service: string;
  status: "firing" | "escalated" | "resolved";
  openedAt: Date;
  resolvedAt: Date | null;
}

export interface NoisyComponent {
  service: string;
  count: number;
}

export interface ReliabilityInsights {
  /** Mean time to resolve (ms) over resolved incidents, or null when none have resolved. */
  mttrMs: number | null;
  /** Incidents opened in the trailing 7 / 30 days. */
  incidentsLast7d: number;
  incidentsLast30d: number;
  /** Currently active (non-resolved) incidents. */
  openCount: number;
  /** Total incidents in the supplied set. */
  total: number;
  /** Services ranked by incident count, descending (top 5). */
  noisiestComponents: NoisyComponent[];
}

const DAY_MS = 24 * 60 * 60_000;
const TOP_N = 5;

export function computeReliabilityInsights(
  incidents: InsightIncident[],
  now: Date,
): ReliabilityInsights {
  const nowMs = now.getTime();

  const resolveDurations = incidents
    .filter((i) => i.status === "resolved" && i.resolvedAt !== null)
    .map((i) => (i.resolvedAt as Date).getTime() - i.openedAt.getTime());
  const mttrMs =
    resolveDurations.length > 0
      ? Math.round(resolveDurations.reduce((a, b) => a + b, 0) / resolveDurations.length)
      : null;

  const incidentsLast7d = incidents.filter((i) => nowMs - i.openedAt.getTime() <= 7 * DAY_MS).length;
  const incidentsLast30d = incidents.filter((i) => nowMs - i.openedAt.getTime() <= 30 * DAY_MS).length;
  const openCount = incidents.filter((i) => i.status !== "resolved").length;

  const byService = new Map<string, number>();
  for (const i of incidents) byService.set(i.service, (byService.get(i.service) ?? 0) + 1);
  const noisiestComponents = [...byService.entries()]
    .map(([service, count]) => ({ service, count }))
    .sort((a, b) => b.count - a.count || a.service.localeCompare(b.service))
    .slice(0, TOP_N);

  return {
    mttrMs,
    incidentsLast7d,
    incidentsLast30d,
    openCount,
    total: incidents.length,
    noisiestComponents,
  };
}
