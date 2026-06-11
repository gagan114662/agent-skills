/**
 * Pure composer for the public status page (#148, ADR-0148). Given component health (from the same
 * `pingDb`/`pingRedis` `/readyz` uses) and the workspace's incidents, derive an overall status and a
 * **redacted** incident history. No IO: the `StatusPageService` reads the inputs and serves this.
 *
 * Redaction is deliberate — the page is unauthenticated, so it carries only the service name, severity,
 * status, and timestamps. Observed/target SLO internals NEVER cross the public boundary.
 */

export type OverallStatus = "operational" | "degraded" | "major_outage";

export interface ComponentInput {
  name: string;
  healthy: boolean;
}

export interface StatusIncidentInput {
  service: string;
  sloKind: string;
  severity: "warning" | "critical";
  status: "firing" | "escalated" | "resolved";
  openedAt: Date;
  resolvedAt: Date | null;
}

export interface StatusInput {
  workspaceName: string;
  components: ComponentInput[];
  incidents: StatusIncidentInput[];
  now: Date;
}

export interface ComponentView {
  name: string;
  status: OverallStatus;
}

/** A redacted incident — no observed/target internals (the page is public). */
export interface StatusIncidentView {
  title: string;
  service: string;
  severity: "warning" | "critical";
  status: "firing" | "escalated" | "resolved";
  openedAt: string;
  resolvedAt: string | null;
}

export interface StatusPageView {
  workspaceName: string;
  overall: OverallStatus;
  components: ComponentView[];
  incidents: StatusIncidentView[];
  generatedAt: string;
}

const SEVERITY_RANK: Record<OverallStatus, number> = {
  operational: 0,
  degraded: 1,
  major_outage: 2,
};

function worst(a: OverallStatus, b: OverallStatus): OverallStatus {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export function composeStatusPage(input: StatusInput): StatusPageView {
  const components: ComponentView[] = input.components.map((c) => ({
    name: c.name,
    status: c.healthy ? "operational" : "major_outage",
  }));

  let overall: OverallStatus = "operational";
  for (const c of components) overall = worst(overall, c.status);

  for (const inc of input.incidents) {
    if (inc.status === "resolved") continue; // history only — not an active degradation
    overall = worst(overall, inc.severity === "critical" ? "major_outage" : "degraded");
  }

  const incidents: StatusIncidentView[] = input.incidents.map((inc) => ({
    title: `${inc.service} ${inc.sloKind} ${inc.severity}`,
    service: inc.service,
    severity: inc.severity,
    status: inc.status,
    openedAt: inc.openedAt.toISOString(),
    resolvedAt: inc.resolvedAt ? inc.resolvedAt.toISOString() : null,
  }));

  return {
    workspaceName: input.workspaceName,
    overall,
    components,
    incidents,
    generatedAt: input.now.toISOString(),
  };
}
