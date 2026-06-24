export type KeywordPrevalidationVerdict = "validated" | "needs_review" | "unvalidated";

export interface KeywordPrevalidationReading {
  keyword: string;
  position: number | null;
  url: string;
  country: string;
  observedAt: Date;
}

export interface KeywordPrevalidationInput {
  query: string;
  provider: string;
  connected: boolean;
  trackedKeywords: readonly string[];
  latest: readonly KeywordPrevalidationReading[];
}

export interface KeywordPrevalidationSignal {
  query: string;
  verdict: KeywordPrevalidationVerdict;
  summary: string;
  evidence: string[];
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function isTracked(query: string, keywords: readonly string[]): boolean {
  const q = normalize(query);
  return keywords.some((keyword) => normalize(keyword) === q);
}

export function buildKeywordPrevalidationSignal(
  input: KeywordPrevalidationInput,
): KeywordPrevalidationSignal {
  const query = input.query.trim().replace(/\s+/g, " ");
  const readings = input.latest.filter((row) => normalize(row.keyword) === normalize(query));
  const best = readings
    .filter((row) => row.position !== null)
    .sort(
      (a, b) => (a.position ?? Number.POSITIVE_INFINITY) - (b.position ?? Number.POSITIVE_INFINITY),
    )[0];
  const tracked = isTracked(query, input.trackedKeywords);
  const evidence: string[] = [
    `provider=${input.provider}`,
    `tracked=${tracked ? "yes" : "no"}`,
    "volume=unavailable until a live SERP/volume provider is connected",
    "intent=must be verified by Scout before drafting",
  ];

  if (!input.connected) {
    return {
      query,
      verdict: "unvalidated",
      summary:
        "No external SEO receipts are connected, so winnability and search volume are unknown.",
      evidence,
    };
  }

  if (!tracked) {
    return {
      query,
      verdict: "needs_review",
      summary:
        "This query is not in the configured SEO target list; owner should confirm audience fit before publishing.",
      evidence,
    };
  }

  if (!best) {
    return {
      query,
      verdict: "needs_review",
      summary: "External SEO receipts exist, but this target has no ranking proof yet.",
      evidence,
    };
  }

  evidence.push(`bestPosition=${best.position}`, `country=${best.country}`, `url=${best.url}`);
  if ((best.position ?? Number.POSITIVE_INFINITY) <= 10) {
    return {
      query,
      verdict: "validated",
      summary: `Existing rank receipt shows page-one traction at position ${best.position}; still verify intent and angle before drafting.`,
      evidence,
    };
  }

  return {
    query,
    verdict: "needs_review",
    summary: `Existing rank receipt is below page one at position ${best.position}; treat this as a winnability risk before drafting.`,
    evidence,
  };
}

export function renderKeywordPrevalidation(signal: KeywordPrevalidationSignal): string {
  return [
    "SEO pre-publication validation:",
    `- verdict: ${signal.verdict}`,
    `- summary: ${signal.summary}`,
    ...signal.evidence.map((item) => `- evidence: ${item}`),
  ].join("\n");
}
