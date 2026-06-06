/**
 * Dependency-free Prometheus metrics registry (#19).
 *
 * We deliberately avoid pulling `prom-client` to keep the runtime lean and the
 * committed lockfile frozen — this is a small, correct subset of the text
 * exposition format. An `onResponse` hook (see ./plugin.ts) feeds it; `GET /metrics`
 * renders it.
 *
 * Cardinality discipline: HTTP series are labelled by the **route template**
 * (`/channels/:cid/messages`), never the raw path, and tenant ids are NOT labels
 * (they live in logs/traces) — both would otherwise explode series count.
 */

/** Histogram buckets in seconds — tuned for a fast JSON API. */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HttpSeries {
  method: string;
  route: string;
  status: number;
  count: number;
}

interface DurationSeries {
  method: string;
  route: string;
  bucketCounts: number[]; // per-bucket (non-cumulative) hit counts, aligned to DURATION_BUCKETS
  inf: number; // observations above the largest bucket
  sum: number;
  count: number;
}

const httpTotals = new Map<string, HttpSeries>();
const durations = new Map<string, DurationSeries>();
let inFlight = 0;

const httpKey = (method: string, route: string, status: number): string =>
  `${method}|${route}|${status}`;
const durKey = (method: string, route: string): string => `${method}|${route}`;

export function incInFlight(): void {
  inFlight += 1;
}

export function decInFlight(): void {
  inFlight = Math.max(0, inFlight - 1);
}

/** Record one completed HTTP request. `durationSeconds` may be 0. */
export function recordRequest(
  method: string,
  route: string,
  status: number,
  durationSeconds: number,
): void {
  const hk = httpKey(method, route, status);
  const existing = httpTotals.get(hk);
  if (existing) {
    existing.count += 1;
  } else {
    httpTotals.set(hk, { method, route, status, count: 1 });
  }

  const dk = durKey(method, route);
  let d = durations.get(dk);
  if (!d) {
    d = { method, route, bucketCounts: DURATION_BUCKETS.map(() => 0), inf: 0, sum: 0, count: 0 };
    durations.set(dk, d);
  }
  d.count += 1;
  d.sum += durationSeconds;
  const idx = DURATION_BUCKETS.findIndex((b) => durationSeconds <= b);
  if (idx === -1) d.inf += 1;
  else d.bucketCounts[idx] = (d.bucketCounts[idx] ?? 0) + 1;
}

/** Reset all series — used by unit tests for isolation. */
export function resetMetrics(): void {
  httpTotals.clear();
  durations.clear();
  inFlight = 0;
}

/** Prometheus label-value escaping (backslash, double-quote, newline). */
function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Render the full registry as Prometheus text exposition. */
export function renderMetrics(): string {
  const lines: string[] = [];

  lines.push("# HELP http_requests_total Total HTTP requests handled.");
  lines.push("# TYPE http_requests_total counter");
  for (const s of httpTotals.values()) {
    lines.push(
      `http_requests_total{method="${esc(s.method)}",route="${esc(s.route)}",status="${s.status}"} ${s.count}`,
    );
  }

  lines.push("# HELP http_request_duration_seconds HTTP request latency in seconds.");
  lines.push("# TYPE http_request_duration_seconds histogram");
  for (const d of durations.values()) {
    const labels = `method="${esc(d.method)}",route="${esc(d.route)}"`;
    let cumulative = 0;
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      cumulative += d.bucketCounts[i] ?? 0;
      lines.push(
        `http_request_duration_seconds_bucket{${labels},le="${DURATION_BUCKETS[i]}"} ${cumulative}`,
      );
    }
    cumulative += d.inf;
    lines.push(`http_request_duration_seconds_bucket{${labels},le="+Inf"} ${cumulative}`);
    lines.push(`http_request_duration_seconds_sum{${labels}} ${d.sum}`);
    lines.push(`http_request_duration_seconds_count{${labels}} ${d.count}`);
  }

  lines.push("# HELP http_requests_in_flight HTTP requests currently being served.");
  lines.push("# TYPE http_requests_in_flight gauge");
  lines.push(`http_requests_in_flight ${inFlight}`);

  lines.push("# HELP process_uptime_seconds Seconds since the process started.");
  lines.push("# TYPE process_uptime_seconds gauge");
  lines.push(`process_uptime_seconds ${process.uptime()}`);

  lines.push("# HELP process_resident_memory_bytes Resident memory size in bytes.");
  lines.push("# TYPE process_resident_memory_bytes gauge");
  lines.push(`process_resident_memory_bytes ${process.memoryUsage().rss}`);

  return lines.join("\n") + "\n";
}
