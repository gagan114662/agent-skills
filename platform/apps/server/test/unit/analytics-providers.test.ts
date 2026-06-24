import { describe, expect, it, vi } from "vitest";
import {
  Ga4AnalyticsProvider,
  PlausibleAnalyticsProvider,
  type AnalyticsFetch,
} from "../../src/analytics/providers.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("analytics live providers (#881)", () => {
  it("reads GA4 Data API metrics for the requested window", async () => {
    const httpFetch = vi.fn<AnalyticsFetch>(async () =>
      jsonResponse({
        totals: [{ metricValues: [{ value: "321" }, { value: "12" }] }],
        rows: [
          { dimensionValues: [{ value: "page_view" }], metricValues: [{ value: "300" }, { value: "0" }] },
          { dimensionValues: [{ value: "sign_up" }], metricValues: [{ value: "21" }, { value: "7" }] },
        ],
      }),
    );
    const provider = new Ga4AnalyticsProvider(
      async () => ({ GA4_ACCESS_TOKEN: "tok", GA4_PROPERTY_ID: "12345" }),
      httpFetch,
    );

    const reading = await provider.readMetrics("ws-1", 14);

    expect(reading).toEqual({ sessions: 321, signups: 7, conversions: 12, windowDays: 14, source: "ga4" });
    expect(String(httpFetch.mock.calls[0]![0])).toContain("/properties/12345:runReport");
    expect(JSON.parse(String((httpFetch.mock.calls[0]![1] as RequestInit).body))).toMatchObject({
      dateRanges: [{ startDate: "14daysAgo", endDate: "today" }],
    });
  });

  it("returns null when GA4 credentials are incomplete", async () => {
    const httpFetch = vi.fn<AnalyticsFetch>();
    const provider = new Ga4AnalyticsProvider(async () => ({ GA4_ACCESS_TOKEN: "tok" }), httpFetch);

    await expect(provider.readMetrics("ws-1", 7)).resolves.toBeNull();
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it("reads Plausible aggregate metrics and signup goal conversions for the requested window", async () => {
    const httpFetch = vi
      .fn<AnalyticsFetch>()
      .mockResolvedValueOnce(jsonResponse({ results: { visitors: { value: 180 }, goal_conversions: { value: 9 } } }))
      .mockResolvedValueOnce(jsonResponse({ results: { goal_conversions: { value: 4 } } }));
    const provider = new PlausibleAnalyticsProvider(
      async () => ({ PLAUSIBLE_API_KEY: "plausible-token", PLAUSIBLE_SITE_ID: "example.com" }),
      httpFetch,
    );

    const reading = await provider.readMetrics("ws-1", 30);

    expect(reading).toEqual({ sessions: 180, signups: 4, conversions: 9, windowDays: 30, source: "plausible" });
    const firstUrl = httpFetch.mock.calls[0]![0] as URL;
    const secondUrl = httpFetch.mock.calls[1]![0] as URL;
    expect(firstUrl.searchParams.get("period")).toBe("30d");
    expect(firstUrl.searchParams.get("site_id")).toBe("example.com");
    expect(secondUrl.searchParams.get("filters")).toBe("event:goal==Signup");
  });
});
