# Spec: Reload Platform — Cloud Scale: Warm Pools, Autoscaling, Multi-Region, Cost Caps (Issue #71)

> Implements [#71](https://github.com/gagan114662/agent-skills/issues/71). Phase 5 — hardening &
> scale. **Builds on #25** (cloud runtime / `AgentRuntime` / `SessionManager`), **#17** (kill
> switch + guards), and Team Mode (`TEAM_MAX_CONCURRENCY`). Part of EPIC #60.
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Built the agent_skills way — every
> stage governed by a skill in `skills/`. Out of scope: the e2e correctness proof (that is #37).

## Objective
**What:** Make cloud agent execution **economical and elastic** for a 24/7 fleet. #25 gave us a
session that runs server-side on an `AgentRuntime`, snapshots its filesystem at teardown, and
streams into a channel — but it cold-provisions every session, has no ceiling on concurrent spend,
runs in a single region, and has no per-tenant cost budget. This issue adds the four scale levers
Conductor tuned and that #25 explicitly deferred:

1. **Warm pool / snapshot-primed spin-up** — keep a buffer of pre-provisioned, **secret-free**
   sandboxes so a launch *binds* (fast) instead of *cold-provisions* (slow), measurably cutting
   spin-up latency. Secrets are injected only at bind, never into a pooled instance.
2. **Autoscaling concurrency with caps** — admit launches up to a **per-tenant** cap and a
   **global** cap (the existing `TEAM_MAX_CONCURRENCY` ceiling); a breach is **rejected** (429),
   never silently exceeded.
3. **Multi-region placement** — place each session in the **least-loaded allowed region** (tenant
   policy), with per-region warm buffers; the chosen region is persisted on the session for audit.
4. **Per-tenant cost/budget caps + usage dashboard + kill switch (#17)** — accumulate per-tenant
   usage (sessions, compute-seconds, estimated cost), **halt new sessions** when a tenant exceeds
   its budget, surface usage via a REST endpoint + a web dashboard, and wire the existing #17 kill
   switch so it halts **all** launches (today it only halts the autonomy tick).

**Why:** Before running a real fleet 24/7 we need the cost and elasticity levers: fast spin-up
(warm pool), a ceiling on concurrent spend (autoscaling caps), geographic placement (multi-region),
and a hard per-tenant cost stop (budget caps + kill switch). These are exactly what #25 deferred.

**Who:** Operators who must keep cloud spend bounded and predictable across many tenants; a tenant
admin who sets a budget and wants new work to stop at the cap (not silently overspend); users who
want sub-second-ish spin-up; on-call who must be able to **hard-stop** a tenant instantly (#17).

### Acceptance criteria (from #71 — BUILD/TDD)
1. **Warm pool measurably cuts spin-up latency vs cold** — a launch served from the warm pool
   provisions via a fast *bind* path; a cold launch provisions via the slow path. The
   `agent_sandbox_spinup_seconds` histogram (already in #19) shows the warm path strictly faster,
   proven with an injected fake provider (no cloud spend).
2. **Concurrency scales under load without breaching caps; a breach is rejected/queued** — N
   concurrent launches are admitted up to the per-tenant + global caps; the next launch is
   rejected with a typed capacity error → REST 429. Released slots admit queued/retried work.
3. **A tenant budget cap halts new sessions and surfaces it** — once a tenant's accumulated usage
   exceeds its configured budget, a launch is denied with `budget_exceeded` (REST 402) and the
   usage endpoint/dashboard shows over-budget. Re-enabling (raising the cap / new window) admits
   again.

### In scope
- **Warm pool** (`runtime/warm-pool.ts`): a `WarmPool` that **decorates** a `SandboxProvider`
  (`implements SandboxProvider`), maintaining a **per-region buffer** of `PrewarmedSandbox`
  instances (slow boot + base image done ahead of time, **no secrets, no task**). On `create`,
  a resume (`snapshotId`) or an empty buffer → cold `provider.create`; otherwise **bind** a
  prewarmed instance (inject env+secrets) → fast. Refills asynchronously up to `size`. The real
  Vercel adapter implements the `WarmableSandboxProvider.prewarm` extension; tests inject a fake.
- **Admission control** (`scale/admission.ts` + pure `scale/decide.ts`): a single chokepoint in
  `SessionManager.launch` that, in order, checks **kill switch (#17) → budget cap → per-tenant
  concurrency → global concurrency** and returns admit / a typed denial. Mirrors the #17
  pure-decision (`decide`/`guards`) + IO-orchestrator (`engine`) split. Live in-flight counters
  (global + per-tenant + per-region) are held in memory; `acquire` on launch, `release` at
  teardown.
- **Multi-region placement** (pure `scale/region.ts`): `planRegion(allowed, loadByRegion, prefer)`
  picks the **least-loaded allowed region** (tie-broken by preference order, then name). The region
  flows through `SandboxCreateOpts.region` and is **persisted** on `agent_sessions.region`.
- **Usage accounting** (`scale/usage.ts` + `tenant_usage` table): per-tenant, per **window**
  (`YYYY-MM`, clock injected) counters — `sessions_started`, `compute_seconds`,
  `estimated_cost_cents` — incremented at session start/finalize. Pure cost math
  (`estimateCostCents(seconds, rateCentsPerMinute)`); pure `budgetExceeded(usage, cap)`.
- **Scale config** (`config/schema.ts` `scaleSchema`, managed/per-tenant layer): `warmPoolSize`,
  `regions` (allowed + preferred), `tenantConcurrency`, `globalConcurrency`, `budgetCents`,
  `computeRateCentsPerMinute`. All **non-secret**, all **opt-in/off by default** (no pool, no caps,
  no budget) so today's behavior is unchanged and tests/CI need no cloud.
- **REST surface**: `GET /workspaces/:wid/scale/usage` (tenant-gated) → current-window usage, the
  resolved caps, per-region in-flight, over-budget flag.
- **Web dashboard** (`apps/web` — reuse #18 one-store + vitest patterns): a Usage panel showing
  sessions, compute, cost vs budget (with an over-budget banner), and per-region concurrency.
- **Observability** (extend the #19 dependency-free registry, same cardinality discipline — no
  tenant labels): `scale_warm_pool_size`, `scale_warm_hits_total`, `scale_warm_misses_total`,
  `scale_admission_denied_total{reason}`, `scale_region_sessions_total{region}`. Reuse the
  existing `agent_sandbox_spinup_seconds` for the warm-vs-cold latency proof.

### Out of scope (deferred / documented-not-automated)
- **The e2e correctness proof** — that is #37.
- **Real Vercel/cloud calls in CI** — `prewarm`/`bind` and multi-region placement are behind the
  `SandboxProvider`/`WarmableSandboxProvider` seam; tests inject fakes → **zero cloud spend** (the
  #25 boundary). A production `WarmableSandboxProvider` (real microVM prewarm + region pinning) is
  a documented follow-up behind the seam.
- **A persistent/queued admission backlog** — a cap breach is **rejected** (429, client retries);
  an internal FIFO queue that drains as slots free is a follow-up (internal launchers — Team Mode —
  already self-throttle via their own worker pool, so they never breach the global cap).
- **Cross-region snapshot replication / failover** — placement is at provision; a session does not
  migrate regions mid-run.
- **Real currency/billing integration** — cost is an *estimate* (compute-seconds × a configured
  rate); invoicing is out of scope.
- **Autoscaling the server fleet itself** (process/replica autoscaling) — this issue scales
  *session concurrency*, not the Node process count.

## Architecture
```
  launch ─► SessionManager.launch
              │  (1) Admission.acquire(workspaceId)            scale/admission.ts ─► decide.ts (pure)
              │        kill switch (#17) ▸ budget ▸ tenant ▸ global   getControls / UsageStore / caps
              │        deny ─► throw AdmissionError ─► route 429/402
              │  (2) planRegion(allowed, loadByRegion, prefer) scale/region.ts (pure)
              │  (3) runtime.start(job{region})
              │            └─ SandboxRuntime ─► WarmPool (implements SandboxProvider)
              │                                   buffer[region] ? bind(secrets) : provider.create   runtime/warm-pool.ts
              │  (4) finalize ─► UsageStore.record(seconds) ▸ Admission.release ▸ metrics
              ▼
  GET /workspaces/:wid/scale/usage ─► UsageStore + caps + Admission snapshot ─► web Usage dashboard
```

- **One chokepoint.** Every launch path (REST, Team Mode, autonomy, subagents, turns) goes through
  `SessionManager.launch`, so putting admission there governs the whole fleet without touching each
  call site. `Admission` is an **optional dep**: unset → today's behavior (no caps), exactly like
  the optional `workspace`/`tracer` deps.
- **Secrets never enter the pool.** A `PrewarmedSandbox` is booted with **no tenant secrets and no
  task** (the slow part: microVM + base image). `bind(env, secrets)` injects them and returns a
  runnable `SandboxInstance`. So a pooled instance is generic and safe to hold across the buffer; a
  bound one is tenant-specific and short-lived. This is the security-correct warm-pool model.
- **Pure decision, IO orchestrator** (mirrors #17): `scale/decide.ts`/`scale/region.ts`/
  `scale/usage.ts` are pure and unit-tested without a DB; `scale/admission.ts` holds the counters
  and the seams and calls the pure deciders.
- **Caps are policy (config), usage is state (DB).** Operators set caps in the managed (optionally
  per-tenant) config layer (#58); `tenant_usage` accumulates runtime consumption; admission compares
  the two. Both default to **off** (no cap, rate 0 → cost 0), preserving #25 behavior.

## Data model
**`tenant_usage`** — `workspace_id, window_key('YYYY-MM'), sessions_started(int), compute_seconds(int),
estimated_cost_cents(int), updated_at`. **PK `(workspace_id, window_key)`** (upsert-increment).
Indexed by `workspace_id`. Migration `0071` + down.

**`agent_sessions.region`** (new nullable column) — the region the session was placed in (null for
local/unplaced). Same migration. Backfilled null; `local` runtime leaves it null.

## Config (managed / per-tenant layer, all non-secret, all opt-in)
```toml
[settings.scale]                 # managed-global, or [workspace.<id>.scale] per-tenant (#58)
warmPoolSize = 2                 # per-region buffer target; 0 (default) = pool off (cold only)
regions = ["iad1", "sfo1"]       # allowed regions; first is the preferred tie-break; [] = unplaced
preferredRegion = "iad1"         # optional explicit preference
tenantConcurrency = 5            # max in-flight sessions per tenant; 0/undef = unlimited
globalConcurrency = 20           # fleet ceiling; defaults to TEAM_MAX_CONCURRENCY-derived env
budgetCents = 5000               # per-window cost cap; 0/undef = no budget
computeRateCentsPerMinute = 2    # cost estimate rate; 0 (default) = cost always 0 (no budget bite)
```

## REST surface (tenant-gated)
```
GET /workspaces/:wid/scale/usage   -> {
  window, sessionsStarted, computeSeconds, estimatedCostCents,
  caps: { tenantConcurrency, globalConcurrency, budgetCents },
  inFlight: { tenant, global, byRegion },
  overBudget: boolean
}
```
Launch denials surface as the existing launch route's error: `429` (capacity / kill switch) or
`402` (budget), with a content-free `{ error, reason }`.

## Commands
```
Typecheck:   pnpm -C platform typecheck
Lint:        pnpm -C platform lint
Unit test:   pnpm -C platform test
Integration: pnpm --filter @reload/server test:integration   (real Postgres)
Build:       pnpm -C platform build
Migrate:     pnpm --filter @reload/server db:migrate
Demo:        platform/scripts/demos/40-cloud-scale.sh
```

## Project structure
```
apps/server/drizzle/0071_cloud_scale.sql(+.down.sql)          tenant_usage + agent_sessions.region
apps/server/src/db/schema/tenant-usage.ts                     drizzle table
apps/server/src/db/repositories/tenant-usage.ts               usage upsert/read (UsageStore impl)
apps/server/src/scale/decide.ts                               pure admission decision
apps/server/src/scale/region.ts                               pure region planner
apps/server/src/scale/usage.ts                                pure cost/window math + UsageStore seam
apps/server/src/scale/caps.ts                                 resolveScaleCaps(config)
apps/server/src/scale/admission.ts                            Admission (counters + seams + decide)
apps/server/src/scale/default.ts                              repo-backed Admission factory
apps/server/src/runtime/warm-pool.ts                          WarmPool + Warmable/Prewarmed seams
apps/server/src/runtime/{types,sandbox,manager,factory,default}.ts   +region, +admission wiring
apps/server/src/config/schema.ts                              +scaleSchema
apps/server/src/observability/metrics.ts                      +scale_* series
apps/server/src/routes/scale.ts                               GET usage
apps/server/src/env.ts                                        +scale env (globalConcurrency default)
apps/web/src/api/client.ts (+types), src/store/store.ts, src/components/UsageDashboard.tsx
apps/server/test/unit/{scale-decide,scale-region,scale-usage,scale-admission,warm-pool}.test.ts
apps/server/test/integration/cloud-scale.test.ts
apps/web/src/components/UsageDashboard.test.tsx
docs/adrs/0040-cloud-scale.md                                 ADR
scripts/demos/40-cloud-scale.sh                               demo (recorded)
```

## Code style
Match the surrounding server code: explicit interfaces for every seam (tests inject fakes), pure
decision logic separated from IO orchestration (the #17 pattern), thin routes delegating to a
single access guard + repo, no `any`, `.js` import suffixes, JSDoc on exported surfaces explaining
*why*. Example (the pure admission decision):
```ts
/** Decide whether a launch may proceed. Order matters: a hard stop (#17) precedes soft caps. */
export function decideAdmission(s: AdmissionState): AdmissionDecision {
  if (s.killSwitch) return { ok: false, reason: "kill_switch" };
  if (s.budgetExceeded) return { ok: false, reason: "budget_exceeded" };
  if (s.tenantInFlight >= s.tenantMax) return { ok: false, reason: "tenant_capacity" };
  if (s.globalInFlight >= s.globalMax) return { ok: false, reason: "global_capacity" };
  return { ok: true };
}
```

## Testing strategy
- **Unit (hermetic, no DB — `pnpm test`):**
  - `scale-decide`: `decideAdmission` returns each denial in priority order (kill switch beats
    budget beats tenant beats global); `0`/undefined caps mean unlimited; admits when under all.
  - `scale-region`: `planRegion` picks the least-loaded allowed region; tie → preference order →
    name; empty allowed list → undefined (unplaced); a non-allowed loaded region is ignored.
  - `scale-usage`: `windowKey(date)` → `YYYY-MM`; `estimateCostCents` rounds compute-seconds ×
    rate; `budgetExceeded` is false when cap is 0/undef and true past the cap.
  - `scale-admission`: `acquire`/`release` move the counters; a tenant at its cap is denied while
    another tenant is admitted; kill switch denies all; an over-budget tenant is denied; release
    re-admits. Seams (usage, controls, caps) are fakes.
  - `warm-pool`: a launch with a primed buffer **binds** (fast path, `warm_hits_total`++) and never
    calls cold `create`; an empty buffer **cold-creates** (`warm_misses_total`++); a `snapshotId`
    resume bypasses the pool; the fake records that a bound instance carries secrets and a
    prewarmed one does **not**; the pool refills up to `size` and drains on shutdown.
- **Integration (real Postgres — `test:integration`):** `cloud-scale`:
  1. set a tenant `budgetCents`/rate so the second session is over budget → first launch 202,
     usage accrues at finalize, second launch **402 `budget_exceeded`**; `GET …/scale/usage` shows
     `overBudget: true`;
  2. set `tenantConcurrency = 1` → one running session, a concurrent launch **429
     `tenant_capacity`**; after the first finalizes, a launch is admitted again;
  3. engage the #17 kill switch → launch **429 `kill_switch`**; disengage → admitted;
  4. cross-tenant: `GET …/scale/usage` for another tenant is tenant-isolated (no leakage).
- **Web (`apps/web` vitest):** `UsageDashboard` renders sessions/compute/cost, shows the
  over-budget banner when `overBudget`, and lists per-region concurrency.
- **Demo** (`scripts/demos/40-cloud-scale.sh`, recorded as the PR video): warm-pool spin-up
  (warm vs cold latency from `/metrics`) + a budget cap halting a session + the usage dashboard.

## Boundaries
- **Always:** keep secrets out of pooled instances (inject only at bind) and out of logs; default
  the pool **off** and every cap **unlimited/0** so #25 behavior is unchanged; make admission a
  single chokepoint in `launch`; keep the pure deciders DB-free and unit-tested; release every
  acquired slot on teardown (even on failure); keep tenant usage tenant-isolated; write the failing
  test first; attach the demo video.
- **Ask first:** turning the warm pool or any cap **on by default**; adding a real cloud
  prewarm/region dependency loaded in CI; introducing a persistent admission queue; changing the
  #25 `SandboxProvider` contract beyond the additive `prewarm`/`region`.
- **Never:** bake a tenant secret into a pooled/prewarmed instance; let a launch exceed a cap
  silently; let a denied launch leak another tenant's usage or a secret in its error; bypass the
  #17 kill switch; merge without approval + video.

## Success criteria
1. Warm pool serves launches via a fast bind path with strictly lower spin-up than cold, proven by
   the spin-up histogram + `warm_hits/misses` (unit).
2. Concurrency is admitted up to per-tenant + global caps and a breach is a typed 429 (unit +
   integration); released slots re-admit.
3. A tenant budget cap halts new sessions (402 `budget_exceeded`) and the usage endpoint/dashboard
   surfaces it (unit + integration + web).
4. Multi-region placement chooses the least-loaded allowed region, persisted on the session (unit).
5. The #17 kill switch halts all launches (integration).
6. `pnpm -C platform typecheck && lint && test && build` green; integration green; zero cloud spend.
7. ADR-0040 + this spec + demo script `scripts/demos/40-cloud-scale.sh` (runs green end-to-end);
   PR links #71. The recorded-video gate was **waived by the owner (@gagan114662)** — approved to
   merge once CI is green.

## Open questions
- None blocking. Default everything off (pool size 0, caps unlimited, rate 0) so the PR is a pure
  capability addition; operators opt in per deployment / per tenant via the managed config layer.
```
