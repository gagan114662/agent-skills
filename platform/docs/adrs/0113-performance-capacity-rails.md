# ADR-0113: Performance & Capacity Rails — load tests, perf budgets, saturation metrics, scaling policy, cost forecast

- **Status:** Accepted (shipped in PR for #113)
- **Date:** 2026-06-10
- **Context issue:** [#113](https://github.com/gagan114662/agent-skills/issues/113)
- **Spec:** [docs/specs/113-performance-capacity-rails.md](../specs/113-performance-capacity-rails.md)
- **Builds on:** [ADR-0019](0019-deploy-observability.md) (dependency-free Prometheus registry +
  `/metrics`), [ADR-0025](0025-cloud-execution.md) (`SessionManager`, the hot launch path),
  [ADR-0040](0040-cloud-scale.md) (`tenant_usage` dollar accounting, admission chokepoint, `scale`
  config + `resolveScaleCaps`), [ADR-0043](0043-stripe-revenue-rails.md) (the signature-verified
  webhook hot path), [ADR-0050](0050-founder-console.md) (the pure roll-up the forecast surfaces in),
  [ADR-0105](0105-fleet-watchdog.md) (the supervisor that consumes the saturation classifier),
  [ADR-0035](0035-config-layering.md) (the layered config the new knobs extend).

> **Numbering note.** Spec/ADR (and any migration) use the `0113` slot (the issue number), per the
> project's by-issue numbering convention (see ADR-0099's note) — chosen to dodge sibling-workspace
> collisions in the shared migration sequence. **This slice ships no migration** (the forecast reads
> existing `tenant_usage` rows; the config additions extend the already-threaded `scaleSchema`).

## Context

The platform can run agents 24/7 (#17/#84/#105) and bills real money (#98), but **nobody has measured
what one box can handle.** Premortem (owner directive): an HN hug or a runaway loop saturates every
venture at once, and capacity/optimization decisions are vibes, not measurements. We had `/metrics`
(#19) but only *activity* counters — nothing that predicts a melting box (queue depth, event-loop lag,
pool wait, Redis latency). We had `tenant_usage` dollar accounting (#71) but no *forecast* and no infra
ceiling, so hosting could surprise-bill (#108). And we had no load test, no perf budget, and no written
capacity model — so a latency/throughput regression could land silently and a scale-out was a guess.

The hard parts are not "send a lot of requests." They are: (a) a perf gate that is **deterministic and
testable** in CI rather than a flaky throughput assertion; (b) saturation sampling that is **free and
fail-soft** (a scrape must never hang on a dead Redis); (c) a **measured** capacity number rather than a
guessed one; (d) a forecast/ceiling that is **read-only** and never accidentally becomes a second
admission gate; and (e) doing all of it **additive, no-migration, default-unchanged**.

## Decisions

1. **A dependency-free closed-loop load driver, not autocannon/k6.** Consistent with #19 (a Prometheus
   subset instead of `prom-client`) and #11 (a hand-rolled OpenAPI doc instead of Swagger), `runLoad`
   is a ~100-line closed-loop harness over the global `fetch` with an **injectable clock**. This keeps
   the lockfile frozen, needs no binary installed in CI, and — critically — makes the percentile and
   budget math unit-testable with a fake request fn and no network. The named tools would add a
   dependency and a non-deterministic, install-gated CI step for no gain over what we can test directly.

2. **The perf gate is pure; the run is the only thing that needs a box.** `evaluateBudgets(results,
   budgets)` and `summarize(samplesMs)` (percentiles) live in `perf/budgets.ts` and are unit-tested for
   pass, each violation kind (req/s floor, p99 ceiling, error-rate ceiling), and the no-budget case.
   `scripts/perf.ts` boots `buildApp` with a **fake SessionManager** (no agent-process spawn),
   `listen({port:0})`, signs up once for an `rid`, drives the hot-path scenarios, writes the capacity
   doc, and exits non-zero on a breach — the CI `perf` job is just that script behind the same
   PG+Redis service block as `integration`. Budgets are **floor guards against catastrophic
   regression** (generous absolute thresholds), not tight SLOs, so the gate catches a 10× slowdown
   without flapping on shared-runner noise.

3. **Saturation is sampled at scrape time, fail-soft, with no new state and no tenant labels.** Four
   gauges join the #19 registry — `queue_depth` (admission global in-flight), `event_loop_lag_seconds`
   (a process-singleton `monitorEventLoopDelay` mean), `pg_pool_connections{state=total|idle|waiting}`
   (read off `getPool()`), and `redis_ping_seconds` (a timed `getRedis().ping()`, **omitted** when
   Redis is absent so a dead Redis degrades the metric, never the scrape). The collection is an
   injected `SaturationCollectorDeps` seam wired in `app.ts`; `GET /metrics` awaits it with a short
   timeout and falls back to the last sample on error. No tenant ids as labels (the #19 cardinality
   rule), no histogram explosion.

4. **The saturation verdict is pure and shared between alerts and the watchdog.**
   `classifySaturation(sample, thresholds) → { level: ok|warn|critical, reasons[] }` is the single
   place a sample becomes a judgment, unit-tested per signal. New rules in `observability/alerts.yml`
   (pool-waiting, event-loop-lag, queue-depth) turn the exported gauges into the #112 SRE alerts; the
   same classifier is the seam the #105 watchdog can later consult to pause revivals on a critical box
   (deferred, additive). One verdict, two consumers.

5. **The server is proven stateless, and the knobs that bound capacity are made explicit.** An
   integration test signs up on app instance A and authenticates the returned `rid` on a *separate*
   instance B over the same Postgres/Redis — proving session/auth state has no in-memory affinity, so
   any replica serves any request (the precondition for horizontal scale-out). The capacity-governing
   worker knobs are surfaced and documented: a **new `DATABASE_POOL_MAX`** env (previously a hard-coded
   `max: 10`), plus the existing `scale.tenantConcurrency` / `scale.globalConcurrency` /
   `TEAM_MAX_CONCURRENCY`. `docs/capacity.md` is **written by the perf run** with measured req/s per
   vCPU; `docs/scaling.md` derives the scale-out model from those numbers — never hand-typed.

6. **Cost forecast + infra ceiling are pure and read-only — they reuse the one dollar accounting.**
   `forecastUsage(trend, nextWindow)` projects next window's compute-seconds/cost from the
   `tenant_usage` trend (zeros for no history, flat for one point, a clamped linear fit for ≥2);
   `recommendRightSizing` turns utilization + the projection into scale-up/down/hold; and
   `infraBudgetStatus(projected, ceiling)` flags a breach **only against a positive
   `scale.infraBudgetCeilingCents`** — mirroring `budgetExceeded`, defaulting to `0` = no ceiling
   (links #108). All three are pure modules in `scale/forecast.ts`, unit-tested per branch. They are
   **read-only**: the projection warns; it never blocks a launch (that stays the #71 admission job).

7. **The forecast surfaces in the Founder Console through the existing read seams.** The #104 pure
   `aggregateFounderConsole` gains a `costForecast` view computed from a gathered `usageTrend` + the
   resolved `scale` caps; the IO orchestrator backs it with a **new additive read**
   `getUsageTrend(workspaceId, windowKeys[])` over `tenant_usage` and `resolveScaleCaps(...)` for the
   caps — no new query authority, no mutation. The owner sees next month's projected spend, the
   right-sizing call, and whether it breaches the infra ceiling in the same daily review.

8. **Additive config, no new top-level block, so no `layers.ts` allowlist trap.** The infra ceiling and
   pool/worker knobs extend the **already-threaded** `scaleSchema` (`infraBudgetCeilingCents`) and env
   (`DATABASE_POOL_MAX`) rather than introducing a new config block — sidestepping the #58/#98 gotcha
   where a new block silently drops unless added to both `mergeSettings` and `mergeLayers`.
   `resolveScaleCaps` gains the ceiling with a `0` default; every other surface is unchanged.

## Consequences

- **Default-unchanged, additive, no migration.** No schema change, no new top-level config block, every
  knob optional with a no-op default (`infraBudgetCeilingCents: 0`, `DATABASE_POOL_MAX: 10`). The only
  always-on addition is four free scrape-time gauges and one process-singleton event-loop monitor.
- **A regression now fails the PR.** The CI `perf` job is a hard gate on the hot paths; a 10× latency
  or throughput regression past the floor budgets blocks the merge instead of landing silently.
- **The box's headroom is visible.** Queue depth, event-loop lag, pool wait, and Redis latency are on
  the dashboard and wired to alerts; the capacity doc says how many req/s a vCPU buys, measured.
- **The bill is bounded and forecast.** The founder sees projected spend + right-sizing + an infra
  ceiling breach before the month closes — hosting can't surprise-bill unnoticed.
- **Deferred (behind seams):** distributed/multi-box load generation (behind `runLoad`/`PerfResult`),
  auto-scaling actuation (behind `recommendRightSizing`), feeding `classifySaturation` into
  `decideRevival`, and load-testing the real spend/runtime paths (the `soak` script's job). Each plugs
  into an existing seam without reshaping this slice.
