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

// --- agent sessions (#25) ---------------------------------------------------
// Cardinality discipline (as for HTTP): labels are bounded to the runtime kind and a small set
// of terminal statuses — tenant ids are NEVER labels (they live in logs/traces).

/** Spin-up histogram buckets in seconds — sandbox provision should be sub-second to a few s. */
const SPINUP_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

const sessionTotals = new Map<string, { runtime: string; status: string; count: number }>();
interface SpinupSeries {
  runtime: string;
  bucketCounts: number[];
  inf: number;
  sum: number;
  count: number;
}
const spinups = new Map<string, SpinupSeries>();
let sessionsActive = 0;

/** A session was launched (provisioning). */
export function recordSessionStarted(): void {
  sessionsActive += 1;
}

/** A session reached a terminal status; decrement the active gauge and count the outcome. */
export function recordSessionEnded(runtime: string, status: string): void {
  sessionsActive = Math.max(0, sessionsActive - 1);
  const key = `${runtime}|${status}`;
  const existing = sessionTotals.get(key);
  if (existing) existing.count += 1;
  else sessionTotals.set(key, { runtime, status, count: 1 });
}

/** Observe sandbox spin-up (provision) latency in seconds. */
export function observeSpinup(runtime: string, seconds: number): void {
  let s = spinups.get(runtime);
  if (!s) {
    s = { runtime, bucketCounts: SPINUP_BUCKETS.map(() => 0), inf: 0, sum: 0, count: 0 };
    spinups.set(runtime, s);
  }
  s.count += 1;
  s.sum += seconds;
  const idx = SPINUP_BUCKETS.findIndex((b) => seconds <= b);
  if (idx === -1) s.inf += 1;
  else s.bucketCounts[idx] = (s.bucketCounts[idx] ?? 0) + 1;
}

// --- cloud workspaces (#55) -------------------------------------------------
// Persistent & shared cloud workspaces: sleep/wake transitions and sync activity. No labels —
// tenant ids live in logs/traces (the #19 cardinality rule).
let cloudWorkspaceSleeps = 0;
let cloudWorkspaceWakes = 0;
let cloudWorkspaceSyncs = 0;
let cloudWorkspaceFilesSynced = 0;

/** A cloud workspace was put to sleep (idle sweep or explicit). */
export function recordCloudWorkspaceSleep(): void {
  cloudWorkspaceSleeps += 1;
}

/** A cloud workspace was woken (resume from snapshot). */
export function recordCloudWorkspaceWake(): void {
  cloudWorkspaceWakes += 1;
}

/** A cloud→local mirror ran; `filesWritten` files were pulled. */
export function recordCloudWorkspaceSync(filesWritten: number): void {
  cloudWorkspaceSyncs += 1;
  cloudWorkspaceFilesSynced += Math.max(0, filesWritten);
}

// --- autonomy loop (#17) ----------------------------------------------------
// Cardinality discipline (as everywhere): the only label is the bounded action kind — tenant ids
// are NEVER labels (they live in logs/traces).
let autonomyTicks = 0;
const autonomyActions = new Map<string, number>();

/** One autonomy tick ran (a single pass over a workspace's active workflows). */
export function recordAutonomyTick(): void {
  autonomyTicks += 1;
}

/** One autonomy action was applied/decided (start | handoff | request_approval | noop | …). */
export function recordAutonomyAction(action: string): void {
  autonomyActions.set(action, (autonomyActions.get(action) ?? 0) + 1);
}

// --- cloud scale (#71) ------------------------------------------------------
// Warm-pool hit/miss, admission denials by reason, and session placement by region. Cardinality
// discipline (as everywhere): the only labels are the bounded denial reason + the region — tenant
// ids are NEVER labels (they live in logs/traces).
let warmHits = 0;
let warmMisses = 0;
const admissionDenials = new Map<string, number>();
const regionSessions = new Map<string, number>();

/** A launch was served from the warm pool (fast bind path). */
export function recordWarmHit(): void {
  warmHits += 1;
}

/** A launch cold-provisioned (empty buffer or a snapshot resume). */
export function recordWarmMiss(): void {
  warmMisses += 1;
}

/** A launch was denied by admission (kill_switch | budget_exceeded | tenant_capacity | global_capacity). */
export function recordAdmissionDenied(reason: string): void {
  admissionDenials.set(reason, (admissionDenials.get(reason) ?? 0) + 1);
}

/** A session was placed in a region (multi-region placement). */
export function recordRegionPlacement(region: string): void {
  regionSessions.set(region, (regionSessions.get(region) ?? 0) + 1);
}

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
  sessionTotals.clear();
  spinups.clear();
  sessionsActive = 0;
  cloudWorkspaceSleeps = 0;
  cloudWorkspaceWakes = 0;
  cloudWorkspaceSyncs = 0;
  cloudWorkspaceFilesSynced = 0;
  autonomyTicks = 0;
  autonomyActions.clear();
  warmHits = 0;
  warmMisses = 0;
  admissionDenials.clear();
  regionSessions.clear();
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

  // --- agent sessions (#25) ---
  lines.push("# HELP agent_sessions_total Agent sessions by runtime and terminal status.");
  lines.push("# TYPE agent_sessions_total counter");
  for (const s of sessionTotals.values()) {
    lines.push(
      `agent_sessions_total{runtime="${esc(s.runtime)}",status="${esc(s.status)}"} ${s.count}`,
    );
  }

  lines.push("# HELP agent_sessions_active Agent sessions currently running.");
  lines.push("# TYPE agent_sessions_active gauge");
  lines.push(`agent_sessions_active ${sessionsActive}`);

  lines.push("# HELP agent_sandbox_spinup_seconds Runtime provision (spin-up) latency.");
  lines.push("# TYPE agent_sandbox_spinup_seconds histogram");
  for (const s of spinups.values()) {
    const labels = `runtime="${esc(s.runtime)}"`;
    let cumulative = 0;
    for (let i = 0; i < SPINUP_BUCKETS.length; i++) {
      cumulative += s.bucketCounts[i] ?? 0;
      lines.push(`agent_sandbox_spinup_seconds_bucket{${labels},le="${SPINUP_BUCKETS[i]}"} ${cumulative}`);
    }
    cumulative += s.inf;
    lines.push(`agent_sandbox_spinup_seconds_bucket{${labels},le="+Inf"} ${cumulative}`);
    lines.push(`agent_sandbox_spinup_seconds_sum{${labels}} ${s.sum}`);
    lines.push(`agent_sandbox_spinup_seconds_count{${labels}} ${s.count}`);
  }

  // --- cloud workspaces (#55) ---
  lines.push("# HELP cloud_workspace_sleeps_total Cloud workspaces put to sleep.");
  lines.push("# TYPE cloud_workspace_sleeps_total counter");
  lines.push(`cloud_workspace_sleeps_total ${cloudWorkspaceSleeps}`);
  lines.push("# HELP cloud_workspace_wakes_total Cloud workspaces woken from sleep.");
  lines.push("# TYPE cloud_workspace_wakes_total counter");
  lines.push(`cloud_workspace_wakes_total ${cloudWorkspaceWakes}`);
  lines.push("# HELP cloud_workspace_syncs_total Cloud→local mirror operations.");
  lines.push("# TYPE cloud_workspace_syncs_total counter");
  lines.push(`cloud_workspace_syncs_total ${cloudWorkspaceSyncs}`);
  lines.push("# HELP cloud_workspace_files_synced_total Files pulled by cloud→local mirrors.");
  lines.push("# TYPE cloud_workspace_files_synced_total counter");
  lines.push(`cloud_workspace_files_synced_total ${cloudWorkspaceFilesSynced}`);

  // --- autonomy loop (#17) ---
  lines.push("# HELP autonomy_ticks_total Autonomy loop ticks executed.");
  lines.push("# TYPE autonomy_ticks_total counter");
  lines.push(`autonomy_ticks_total ${autonomyTicks}`);

  lines.push("# HELP autonomy_actions_total Autonomy actions by kind.");
  lines.push("# TYPE autonomy_actions_total counter");
  for (const [action, count] of autonomyActions) {
    lines.push(`autonomy_actions_total{action="${esc(action)}"} ${count}`);
  }

  // --- cloud scale (#71) ---
  lines.push("# HELP scale_warm_hits_total Launches served from the warm pool (fast bind path).");
  lines.push("# TYPE scale_warm_hits_total counter");
  lines.push(`scale_warm_hits_total ${warmHits}`);
  lines.push("# HELP scale_warm_misses_total Launches that cold-provisioned (empty buffer or resume).");
  lines.push("# TYPE scale_warm_misses_total counter");
  lines.push(`scale_warm_misses_total ${warmMisses}`);

  lines.push("# HELP scale_admission_denied_total Launches denied by admission, by reason.");
  lines.push("# TYPE scale_admission_denied_total counter");
  for (const [reason, count] of admissionDenials) {
    lines.push(`scale_admission_denied_total{reason="${esc(reason)}"} ${count}`);
  }

  lines.push("# HELP scale_region_sessions_total Sessions placed, by region.");
  lines.push("# TYPE scale_region_sessions_total counter");
  for (const [region, count] of regionSessions) {
    lines.push(`scale_region_sessions_total{region="${esc(region)}"} ${count}`);
  }

  return lines.join("\n") + "\n";
}
