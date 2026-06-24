import type { SaturationSample } from "./saturation.js";

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

// --- background loop liveness (#876) ----------------------------------------
// Top-level tick failures can happen before any per-workspace tick counter increments
// (maintenance/listing/signal reads). Keep labels bounded to known loop names.
const loopTickFailures = new Map<string, number>();
const webhookSignatureFailures = new Map<string, { provider: string; reason: string; count: number }>();
const asyncSideEffectFailures = new Map<string, number>();
const redisPubSubTimeouts = new Map<string, number>();

export function recordLoopTickFailure(loop: string): void {
  loopTickFailures.set(loop, (loopTickFailures.get(loop) ?? 0) + 1);
}

export function recordWebhookSignatureFailure(provider: string, reason: string): void {
  const safeProvider = provider || "unknown";
  const safeReason = reason || "invalid_signature";
  const key = `${safeProvider}|${safeReason}`;
  const existing = webhookSignatureFailures.get(key);
  if (existing) existing.count += 1;
  else webhookSignatureFailures.set(key, { provider: safeProvider, reason: safeReason, count: 1 });
}

export function recordAsyncSideEffectFailure(kind: string): void {
  const safeKind = kind || "unknown";
  asyncSideEffectFailures.set(safeKind, (asyncSideEffectFailures.get(safeKind) ?? 0) + 1);
}

export function recordRedisPubSubTimeout(operation: string): void {
  const safeOperation = operation || "unknown";
  redisPubSubTimeouts.set(safeOperation, (redisPubSubTimeouts.get(safeOperation) ?? 0) + 1);
}

// --- saturation signals (#113) ----------------------------------------------
// The four signals that predict a melting box — queue depth, event-loop lag, PG pool wait, Redis ping
// latency — sampled at scrape time (see observability/saturation.ts + plugin.ts) and stored here as the
// latest reading. No tenant labels (the #19 cardinality rule); pool state is the only (bounded) label.
let saturationSample: SaturationSample | null = null;

/** Store the latest saturation reading (the scrape handler samples then renders). */
export function setSaturationSample(sample: SaturationSample): void {
  saturationSample = sample;
}

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
// #394/#436: bounded inline retries of a transient, pre-progress session death (spawn / null-exit).
// The before/after signal for reliability work — every increment is a session death that was caught
// and re-attempted instead of being finalized `failed`. Labelled only by runtime kind (no tenant ids).
const sessionRetries = new Map<string, { runtime: string; count: number }>();

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

/**
 * #436: a transient pre-progress session death was caught and the start→wait cycle re-attempted.
 * Counts retries (not sessions): a session retried twice increments twice.
 */
export function recordSessionRetry(runtime: string): void {
  const existing = sessionRetries.get(runtime);
  if (existing) existing.count += 1;
  else sessionRetries.set(runtime, { runtime, count: 1 });
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

// --- fleet watchdog (#105) --------------------------------------------------
// Stalled-session supervisor: ticks executed + actions applied by kind (revive | escalate |
// wait:* | noop:*). Cardinality discipline (as everywhere): the only label is the bounded action
// kind — tenant ids are NEVER labels (they live in logs/traces).
let watchdogTicks = 0;
const watchdogActions = new Map<string, number>();

/** One watchdog tick ran (a single pass over a workspace's live sessions). */
export function recordWatchdogTick(): void {
  watchdogTicks += 1;
}

/** One watchdog action was applied/decided (revive | escalate | wait:* | noop:*). */
export function recordWatchdogAction(action: string): void {
  watchdogActions.set(action, (watchdogActions.get(action) ?? 0) + 1);
}

// --- SRE loop (#112) --------------------------------------------------------
// Agent on-call: ticks executed + actions applied by kind (open | escalate | resolve | notify |
// noop:*). Cardinality discipline (as everywhere): the only label is the bounded action kind —
// tenant ids are NEVER labels (they live in logs/traces).
let sreTicks = 0;
const sreActions = new Map<string, number>();

/** One SRE tick ran (a single pass over a workspace's declared SLOs). */
export function recordSreTick(): void {
  sreTicks += 1;
}

/** One SRE action was applied/decided (open | escalate | resolve | notify | noop:*). */
export function recordSreAction(action: string): void {
  sreActions.set(action, (sreActions.get(action) ?? 0) + 1);
}

// --- Self-Healing Ops (#193) ------------------------------------------------
// Per-venture monitoring + bounded auto-remediation: ticks executed + actions applied by kind
// (restart | rollback | scale_up | escalate | resolve | open | none | noop:*). Same cardinality
// discipline — the only label is the bounded action kind; tenant ids are never labels.
let selfHealingTicks = 0;
const selfHealingActions = new Map<string, number>();

/** One self-healing tick ran (a single pass over a workspace's venture surfaces). */
export function recordSelfHealingTick(): void {
  selfHealingTicks += 1;
}

/** One self-healing action was applied/decided (restart | rollback | scale_up | escalate | resolve | …). */
export function recordSelfHealingAction(action: string): void {
  selfHealingActions.set(action, (selfHealingActions.get(action) ?? 0) + 1);
}

/**
 * Read-only snapshot of the HTTP series the SRE signal source derives SLOs from (#112). Aggregated
 * across all route templates: total requests, server-error (5xx) count, and an approximate p95 latency
 * in milliseconds (the upper bound of the bucket the 95th percentile falls in). No new state — it
 * reads the same counters `/metrics` renders, so the loop alerts off exactly what we expose.
 */
export interface HttpMetricsSnapshot {
  requests: number;
  errors: number;
  p95LatencyMs: number;
}

export function snapshotHttpMetrics(): HttpMetricsSnapshot {
  let requests = 0;
  let errors = 0;
  for (const s of httpTotals.values()) {
    requests += s.count;
    if (s.status >= 500) errors += s.count;
  }

  // Aggregate the per-route duration histograms into one, then read the 95th-percentile bucket.
  const agg = DURATION_BUCKETS.map(() => 0);
  let aggInf = 0;
  let aggCount = 0;
  for (const d of durations.values()) {
    for (let i = 0; i < DURATION_BUCKETS.length; i++) agg[i] = (agg[i] ?? 0) + (d.bucketCounts[i] ?? 0);
    aggInf += d.inf;
    aggCount += d.count;
  }
  let p95LatencyMs = 0;
  if (aggCount > 0) {
    const threshold = 0.95 * aggCount;
    let cumulative = 0;
    let found = false;
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      cumulative += agg[i] ?? 0;
      if (cumulative >= threshold) {
        p95LatencyMs = (DURATION_BUCKETS[i] ?? 0) * 1000;
        found = true;
        break;
      }
    }
    if (!found && aggInf > 0) p95LatencyMs = (DURATION_BUCKETS[DURATION_BUCKETS.length - 1] ?? 0) * 1000;
  }

  return { requests, errors, p95LatencyMs };
}

// --- self-healing flywheel (#117) -------------------------------------------
// Failure→issue→fix loop: ticks executed + actions by kind (ingest:new | ingest:dedup |
// ingest:recurred | issue:draft | issue:comment | issue:reopen | issue:rate_limited | dispatch:auto |
// dispatch:queue | dispatch:skip:* | fixed | noop:kill_switch). Cardinality discipline (as everywhere):
// the only label is the bounded action kind — tenant ids are NEVER labels (they live in logs/traces).
let flywheelTicks = 0;
const flywheelActions = new Map<string, number>();

/** One flywheel tick ran (a single pass over a workspace's open fingerprints). */
export function recordFlywheelTick(): void {
  flywheelTicks += 1;
}

/** One flywheel action was applied/decided. */
export function recordFlywheelAction(action: string): void {
  flywheelActions.set(action, (flywheelActions.get(action) ?? 0) + 1);
}

// --- self-shipping loop (#172) ----------------------------------------------
// Build→review→merge loop: ticks executed + actions by kind (ingest:new | dispatch:build |
// dispatch:skip:* | advance:reviewing | advance:revising | review:pass | review:fail | merge:auto |
// escalate:* | rebase:continue | rebase:route_back | post_merge:clean | post_merge:propose_revert |
// noop:kill_switch). Cardinality discipline: the only label is the bounded action kind — tenant ids
// are NEVER labels (they live in logs/traces).
let buildLoopTicks = 0;
const buildLoopActions = new Map<string, number>();

/** One self-shipping-loop tick ran (a single pass over a workspace's runs). */
export function recordBuildLoopTick(): void {
  buildLoopTicks += 1;
}

/** One self-shipping-loop action was applied/decided. */
export function recordBuildLoopAction(action: string): void {
  buildLoopActions.set(action, (buildLoopActions.get(action) ?? 0) + 1);
}

// --- outcome verifiers (#106) -----------------------------------------------
// Measured-gate runner: ticks executed + actions by kind (`<kind>:passed` | `<kind>:failed` |
// `<kind>:errored` | escalate | noop:kill_switch). Cardinality discipline (as everywhere): the only
// label is the bounded action kind — tenant ids are NEVER labels (they live in logs/traces).
let verifierTicks = 0;
const verifierActions = new Map<string, number>();

/** One verifier tick ran (a single pass over a workspace's due claims). */
export function recordVerifierTick(): void {
  verifierTicks += 1;
}

/** One verifier action was applied/decided. */
export function recordVerifierAction(action: string): void {
  verifierActions.set(action, (verifierActions.get(action) ?? 0) + 1);
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
  sessionRetries.clear();
  sessionsActive = 0;
  cloudWorkspaceSleeps = 0;
  cloudWorkspaceWakes = 0;
  cloudWorkspaceSyncs = 0;
  cloudWorkspaceFilesSynced = 0;
  autonomyTicks = 0;
  autonomyActions.clear();
  watchdogTicks = 0;
  watchdogActions.clear();
  sreTicks = 0;
  sreActions.clear();
  selfHealingTicks = 0;
  selfHealingActions.clear();
  flywheelTicks = 0;
  flywheelActions.clear();
  buildLoopTicks = 0;
  buildLoopActions.clear();
  verifierTicks = 0;
  verifierActions.clear();
  warmHits = 0;
  warmMisses = 0;
  admissionDenials.clear();
  regionSessions.clear();
  saturationSample = null;
  loopTickFailures.clear();
  webhookSignatureFailures.clear();
  asyncSideEffectFailures.clear();
  redisPubSubTimeouts.clear();
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

  lines.push("# HELP loop_tick_failures_total Background loop top-level tick failures by loop.");
  lines.push("# TYPE loop_tick_failures_total counter");
  for (const [loop, count] of loopTickFailures) {
    lines.push(`loop_tick_failures_total{loop="${esc(loop)}"} ${count}`);
  }

  lines.push("# HELP webhook_signature_failures_total Signature verification failures on unauthenticated inbound webhooks.");
  lines.push("# TYPE webhook_signature_failures_total counter");
  for (const s of webhookSignatureFailures.values()) {
    lines.push(
      `webhook_signature_failures_total{provider="${esc(s.provider)}",reason="${esc(s.reason)}"} ${s.count}`,
    );
  }

  lines.push("# HELP async_side_effect_failures_total Durable writes whose downstream side effect failed.");
  lines.push("# TYPE async_side_effect_failures_total counter");
  for (const [kind, count] of asyncSideEffectFailures) {
    lines.push(`async_side_effect_failures_total{kind="${esc(kind)}"} ${count}`);
  }

  lines.push("# HELP redis_pubsub_timeouts_total Redis pub/sub commands that exceeded the realtime timeout.");
  lines.push("# TYPE redis_pubsub_timeouts_total counter");
  for (const [operation, count] of redisPubSubTimeouts) {
    lines.push(`redis_pubsub_timeouts_total{operation="${esc(operation)}"} ${count}`);
  }

  lines.push("# HELP process_uptime_seconds Seconds since the process started.");
  lines.push("# TYPE process_uptime_seconds gauge");
  lines.push(`process_uptime_seconds ${process.uptime()}`);

  lines.push("# HELP process_resident_memory_bytes Resident memory size in bytes.");
  lines.push("# TYPE process_resident_memory_bytes gauge");
  lines.push(`process_resident_memory_bytes ${process.memoryUsage().rss}`);

  // --- saturation signals (#113) ---
  // Rendered only once a sample exists (the scrape handler samples before rendering). These are the
  // capacity signals the #112 alerts + the #105 watchdog consume; thresholds live in saturation.ts.
  if (saturationSample) {
    const s = saturationSample;
    lines.push("# HELP queue_depth Sessions the fleet currently has in flight (admission work queue).");
    lines.push("# TYPE queue_depth gauge");
    lines.push(`queue_depth ${s.queueDepth}`);

    lines.push("# HELP event_loop_lag_seconds Mean Node event-loop delay in seconds.");
    lines.push("# TYPE event_loop_lag_seconds gauge");
    lines.push(`event_loop_lag_seconds ${s.eventLoopLagSeconds}`);

    lines.push("# HELP pg_pool_connections Postgres pool connections by state.");
    lines.push("# TYPE pg_pool_connections gauge");
    lines.push(`pg_pool_connections{state="total"} ${s.pgPool.total}`);
    lines.push(`pg_pool_connections{state="idle"} ${s.pgPool.idle}`);
    lines.push(`pg_pool_connections{state="waiting"} ${s.pgPool.waiting}`);

    // Omitted when null — a degraded/absent Redis is the absence of the series, not a 0 reading.
    if (s.redisLatencySeconds !== null) {
      lines.push("# HELP redis_ping_seconds Redis PING round-trip latency in seconds.");
      lines.push("# TYPE redis_ping_seconds gauge");
      lines.push(`redis_ping_seconds ${s.redisLatencySeconds}`);
    }
  }

  // --- agent sessions (#25) ---
  lines.push("# HELP agent_sessions_total Agent sessions by runtime and terminal status.");
  lines.push("# TYPE agent_sessions_total counter");
  for (const s of sessionTotals.values()) {
    lines.push(
      `agent_sessions_total{runtime="${esc(s.runtime)}",status="${esc(s.status)}"} ${s.count}`,
    );
  }

  lines.push(
    "# HELP agent_session_retries_total Transient pre-progress session deaths caught and re-attempted (#436).",
  );
  lines.push("# TYPE agent_session_retries_total counter");
  for (const s of sessionRetries.values()) {
    lines.push(`agent_session_retries_total{runtime="${esc(s.runtime)}"} ${s.count}`);
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

  // --- fleet watchdog (#105) ---
  lines.push("# HELP watchdog_ticks_total Fleet-watchdog ticks executed.");
  lines.push("# TYPE watchdog_ticks_total counter");
  lines.push(`watchdog_ticks_total ${watchdogTicks}`);

  lines.push("# HELP watchdog_actions_total Fleet-watchdog actions by kind.");
  lines.push("# TYPE watchdog_actions_total counter");
  for (const [action, count] of watchdogActions) {
    lines.push(`watchdog_actions_total{action="${esc(action)}"} ${count}`);
  }

  // --- SRE loop (#112) ---
  lines.push("# HELP sre_ticks_total SRE on-call loop ticks executed.");
  lines.push("# TYPE sre_ticks_total counter");
  lines.push(`sre_ticks_total ${sreTicks}`);

  lines.push("# HELP sre_actions_total SRE on-call actions by kind.");
  lines.push("# TYPE sre_actions_total counter");
  for (const [action, count] of sreActions) {
    lines.push(`sre_actions_total{action="${esc(action)}"} ${count}`);
  }

  // --- Self-Healing Ops (#193) ---
  lines.push("# HELP self_healing_ticks_total Self-healing ops loop ticks executed.");
  lines.push("# TYPE self_healing_ticks_total counter");
  lines.push(`self_healing_ticks_total ${selfHealingTicks}`);

  lines.push("# HELP self_healing_actions_total Self-healing ops actions by kind.");
  lines.push("# TYPE self_healing_actions_total counter");
  for (const [action, count] of selfHealingActions) {
    lines.push(`self_healing_actions_total{action="${esc(action)}"} ${count}`);
  }

  // --- self-healing flywheel (#117) ---
  lines.push("# HELP flywheel_ticks_total Self-healing flywheel ticks executed.");
  lines.push("# TYPE flywheel_ticks_total counter");
  lines.push(`flywheel_ticks_total ${flywheelTicks}`);

  lines.push("# HELP flywheel_actions_total Self-healing flywheel actions by kind.");
  lines.push("# TYPE flywheel_actions_total counter");
  for (const [action, count] of flywheelActions) {
    lines.push(`flywheel_actions_total{action="${esc(action)}"} ${count}`);
  }

  // --- self-shipping loop (#172) ---
  lines.push("# HELP build_loop_ticks_total Self-shipping loop ticks executed.");
  lines.push("# TYPE build_loop_ticks_total counter");
  lines.push(`build_loop_ticks_total ${buildLoopTicks}`);

  lines.push("# HELP build_loop_actions_total Self-shipping loop actions by kind.");
  lines.push("# TYPE build_loop_actions_total counter");
  for (const [action, count] of buildLoopActions) {
    lines.push(`build_loop_actions_total{action="${esc(action)}"} ${count}`);
  }

  // --- outcome verifiers (#106) ---
  lines.push("# HELP verifier_ticks_total Outcome-verifier ticks executed.");
  lines.push("# TYPE verifier_ticks_total counter");
  lines.push(`verifier_ticks_total ${verifierTicks}`);

  lines.push("# HELP verifier_actions_total Outcome-verifier actions by kind.");
  lines.push("# TYPE verifier_actions_total counter");
  for (const [action, count] of verifierActions) {
    lines.push(`verifier_actions_total{action="${esc(action)}"} ${count}`);
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
