/**
 * Analytics read providers (issue #270, #881).
 *
 * Dry-run reads nothing. GA4 and Plausible read secrets from the injected #192/#267 credential resolver
 * and call the vendor APIs for the requested trailing window. A missing credential or failed vendor read
 * returns `null`, never fabricated zeroes.
 */

import type { AnalyticsProvider, AnalyticsReading } from "./types.js";

/** The default provider: records an install but reports no numbers (no live vendor is contacted). */
export class DryRunAnalyticsProvider implements AnalyticsProvider {
  readonly id = "dryrun";
  async readMetrics(_workspaceId: string, _windowDays: number): Promise<AnalyticsReading | null> {
    return null;
  }
}
/** Resolves the vendor secrets for a workspace, or `{}` when none is connected. */
export type AnalyticsCredentialResolver = (
  workspaceId: string,
  provider: "ga4" | "plausible",
) => Promise<Record<string, string>>;
export type AnalyticsFetch = typeof fetch;

function positiveInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function requireFetch(httpFetch?: AnalyticsFetch): AnalyticsFetch {
  const f = httpFetch ?? globalThis.fetch;
  if (!f) throw new Error("analytics provider requires fetch");
  return f.bind(globalThis) as AnalyticsFetch;
}

/**
 * GA4 Data API reader. Expects vault secrets:
 * - `GA4_ACCESS_TOKEN` or `GOOGLE_ANALYTICS_ACCESS_TOKEN`
 * - `GA4_PROPERTY_ID` or `GOOGLE_ANALYTICS_PROPERTY_ID`
 */
export class Ga4AnalyticsProvider implements AnalyticsProvider {
  readonly id = "ga4";
  private readonly httpFetch: AnalyticsFetch;

  constructor(
    private readonly resolveCredential: AnalyticsCredentialResolver,
    httpFetch?: AnalyticsFetch,
  ) {
    this.httpFetch = requireFetch(httpFetch);
  }

  async readMetrics(workspaceId: string, windowDays: number): Promise<AnalyticsReading | null> {
    const secrets = await this.resolveCredential(workspaceId, "ga4");
    const token = secrets.GA4_ACCESS_TOKEN ?? secrets.GOOGLE_ANALYTICS_ACCESS_TOKEN;
    const propertyId = secrets.GA4_PROPERTY_ID ?? secrets.GOOGLE_ANALYTICS_PROPERTY_ID;
    if (!token || !propertyId) return null;

    const res = await this.httpFetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          dateRanges: [{ startDate: `${windowDays}daysAgo`, endDate: "today" }],
          metrics: [{ name: "sessions" }, { name: "conversions" }],
          dimensions: [{ name: "eventName" }],
        }),
      },
    );
    if (!res.ok) return null;

    const body = (await res.json()) as {
      totals?: Array<{ metricValues?: Array<{ value?: string }> }>;
      rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }>;
    };
    const totals = body.totals?.[0]?.metricValues ?? [];
    const rows = body.rows ?? [];
    const signups = rows
      .filter((row) => (row.dimensionValues?.[0]?.value ?? "").toLowerCase() === "sign_up")
      .reduce((sum, row) => sum + positiveInt(row.metricValues?.[1]?.value), 0);

    return {
      sessions: positiveInt(totals[0]?.value),
      signups,
      conversions: positiveInt(totals[1]?.value),
      windowDays,
      source: "ga4",
    };
  }
}

/** Plausible Stats API reader. Expects `PLAUSIBLE_API_KEY` and `PLAUSIBLE_SITE_ID` in the vault. */
export class PlausibleAnalyticsProvider implements AnalyticsProvider {
  readonly id = "plausible";
  private readonly httpFetch: AnalyticsFetch;

  constructor(
    private readonly resolveCredential: AnalyticsCredentialResolver,
    httpFetch?: AnalyticsFetch,
  ) {
    this.httpFetch = requireFetch(httpFetch);
  }

  async readMetrics(workspaceId: string, windowDays: number): Promise<AnalyticsReading | null> {
    const secrets = await this.resolveCredential(workspaceId, "plausible");
    const token = secrets.PLAUSIBLE_API_KEY;
    const siteId = secrets.PLAUSIBLE_SITE_ID;
    if (!token || !siteId) return null;

    const base = new URL("https://plausible.io/api/v1/stats/aggregate");
    base.searchParams.set("site_id", siteId);
    base.searchParams.set("period", `${windowDays}d`);
    base.searchParams.set("metrics", "visitors,goal_conversions");
    const all = await this.httpFetch(base, { headers: { authorization: `Bearer ${token}` } });
    if (!all.ok) return null;

    const signupUrl = new URL(base);
    signupUrl.searchParams.set("filters", "event:goal==Signup");
    const signup = await this.httpFetch(signupUrl, { headers: { authorization: `Bearer ${token}` } });
    if (!signup.ok) return null;

    const allBody = (await all.json()) as {
      results?: { visitors?: { value?: number }; goal_conversions?: { value?: number } };
    };
    const signupBody = (await signup.json()) as { results?: { goal_conversions?: { value?: number } } };

    return {
      sessions: positiveInt(allBody.results?.visitors?.value),
      signups: positiveInt(signupBody.results?.goal_conversions?.value),
      conversions: positiveInt(allBody.results?.goal_conversions?.value),
      windowDays,
      source: "plausible",
    };
  }
}

/** Select the read provider by config kind. Unknown / `dryrun` => the no-network dry-run provider. */
export function selectAnalyticsProvider(
  kind: string,
  resolveCredential: AnalyticsCredentialResolver,
  httpFetch?: AnalyticsFetch,
): AnalyticsProvider {
  switch (kind) {
    case "ga4":
      return new Ga4AnalyticsProvider(resolveCredential, httpFetch);
    case "plausible":
      return new PlausibleAnalyticsProvider(resolveCredential, httpFetch);
    default:
      return new DryRunAnalyticsProvider();
  }
}
