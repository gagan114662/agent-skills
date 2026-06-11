# Spec: Reload Platform — SRE Loop: agent on-call (SLOs, alerts, incidents, postmortems) (Issue #112)

> Implements [#112](https://github.com/gagan114662/agent-skills/issues/112). Phase 5 — operating the
> 24/7 fleet. **Builds on #19** (`/metrics` registry + `/healthz`/`/readyz` probes), **#25/#84/#92**
> (`SessionManager` / real agent sessions / `AutonomyLauncher` seam), **#17** (pure `decide`/`guards`
> + kill switch), **#71** (`tenant_usage` budget), **#99** (maintenance Redis flag + DR runbook),
> **#13** (governance approvals queue), and **#104** (Founder Console). Lifecycle: **DEFINE** artifact
> (`spec-driven-development`) → atomic plan → TDD failing-first → ADR → one PR. **Video gate waived by
> the owner.**

## Objective

**What:** An **SRE Loop** — the platform's agent on-call — that runs on infrastructure time and closes
the operate-the-service gap. Coding is the easy part; today nothing pages anyone, nothing triages,
incidents leave no trace, and a fix depends on a human happening to notice. The SRE Loop removes the
human from the *detection* loop and puts an agent on the *triage* loop:

1. **SLOs per service with error budgets** — each service declares SLO targets in config
   (availability, p95 latency, queue lag). A **pure evaluation module** turns a live observation into
   an `SloEvaluation` (met/breached, **error budget remaining**, severity). No vendor, no agent — just
   arithmetic, unit-tested for every branch.
2. **Alert evaluation on infrastructure time** — a periodic **SRE tick** (default OFF) reads the
   existing **`/metrics`** series + **health probes**, derives one observation per service, and runs
   the pure `decideAlert`. A threshold breach **opens a workspace-scoped incident row** (`sre_incidents`)
   and **notifies**. Recovery **resolves** the incident. One open incident per `service+slo` (a partial
   unique index dedupes).
3. **Incident response → triage agent** — opening an incident **auto-launches a triage agent session**
   through the #92 `AutonomyLauncher` with a **failure bundle** (the breached SLO + observed/target,
   recent log/trace context, the last deploys, and runbook links) composed as **data, never argv**.
   **Kill-switch gated** (#17), **maintenance-gated** (#99 — the whole tick pauses), and **#13 approval
   for any risky remediation** (a `critical` incident enqueues an `sre.remediate` approval instead of
   acting). The bundle links the **#99 DR runbook** for data-plane incidents.
4. **Postmortems** — when an incident resolves, the loop **drafts a postmortem** (timeline + 5-whys
   skeleton) into **`docs/postmortems/`** and records the path on the incident. The **Founder Console
   (#104)** links the recent postmortems read-only.
5. **Game days** — a scheduled **chaos drill** (`pnpm sre:drill`, like `dr:drill`) injects a degraded
   signal (Redis down / PG slow) and **proves the alert fires and the triage launches**, failing
   loudly in CI if it does not — so the on-call path is exercised on a Tuesday, not at 2 a.m.

**The pure core (the testable gate):** `evaluateSlo(target, observation) → SloEvaluation` and
`decideAlert(input) → { action: "open" | "resolve" | "notify" | "escalate" | "noop"; reason;
severity }`. Like #17 `decideWorkflowAction` and #105 `decideRevival`, they are pure and unit-tested
for every branch; the engine does the side effects (open the incident row, launch the triage session,
enqueue the #13 remediation, notify, draft the postmortem on resolve).

**Why:** Premortem (owner): "operating services is unsolved — today nothing pages anyone, nothing
triages, incidents leave no trace." A 24/7 autonomous fleet must detect SLO breaches, open a durable
incident, put an agent on triage within guardrails, and leave a written postmortem — on its own.

**Who:** Operators of the autonomous fleet (the loop is the on-call); a founder (Gagan) who wants
breaches escalated for judgment and every incident traceable; the agents themselves, whose work the
SLOs protect.

## Default OFF (unchanged behavior)

The SRE Loop is **doubly opt-in**, exactly like the #17 autonomy loop and #105 watchdog:

- `SRE_INTERVAL_MS` defaults to `0` → the background timer never starts (tests drive `tick()`).
- `sre.enabled` config defaults to `false` → even a manually-driven tick short-circuits per workspace
  (no evaluation, no incident) until an operator opts in and declares SLO targets.

A deployment that sets neither keeps today's behavior precisely: no new always-on work, no new network
call. `/metrics` and the health probes already exist.

## Acceptance criteria (from #112 — BUILD/TDD)

1. **Pure SLO evaluation + error budget** — `evaluateSlo(target, observation)` for each kind
   (`availability`, `latency_p95`, `queue_lag`) returns `{ breached, budgetRemaining, severity }`:
   availability burns budget as the success ratio drops below target; latency/queue-lag breach when the
   observed value exceeds the target. Error budget = how far into the allowed-failure allowance the
   window has burned (clamped 0..1). Proven by unit tests for every kind + boundary.
2. **Pure `decideAlert` yields every action** — `noop` (not breached, no open incident), `open`
   (breached, no open incident), `notify`/`noop` (breached, incident already open — re-page only past
   the cooldown), `resolve` (recovered, incident open), `escalate` (a `critical` breach needs human
   remediation). Order is deliberate (maintenance/kill handled by the engine; recovery before breach).
   Proven by unit tests.
3. **Alert evaluation off `/metrics` + health** — the production signal source derives availability
   from `http_requests_total` (success ÷ total), p95 from the `http_request_duration_seconds`
   histogram, and per-dependency health from `/readyz`'s `pingDb`/`pingRedis`. Pure observation
   mapping is unit-tested; the wiring is exercised by the integration test + the drill.
4. **Kill switch + maintenance gate the tick** — `tickAll()` skips entirely when the #99 maintenance
   flag is active (BEFORE any DB call); a workspace pass returns immediately when its #17 kill switch is
   engaged. Proven by a unit test asserting the store/signal source is never called.
5. **Incident response launches a triage agent with a failure bundle** — opening an incident finalizes
   to a durable `sre_incidents` row, notifies, and launches one triage session via the
   `AutonomyLauncher` with a composed failure bundle (data, never argv) carrying the runbook links; a
   `critical` incident additionally enqueues an `sre.remediate` #13 approval (risky remediation never
   auto-runs). Proven by unit + integration tests.
6. **Postmortem drafted + linked, on real Postgres** — an integration test induces a breach (a degraded
   signal in an isolated workspace), runs the tick, and asserts: an `sre_incidents` row opened
   (`firing` → triage launched, fake launcher), a notification emitted; then a recovering signal +
   second tick resolves it and a postmortem markdown is drafted under `docs/postmortems/` with its path
   recorded on the row; the Founder Console surfaces the postmortem link. **Per-workspace isolation**: a
   breach in workspace A never opens an incident in workspace B.
7. **Game-day drill runnable in CI** — `pnpm --filter @reload/server sre:drill` injects a Redis-down /
   PG-slow signal against a throwaway Postgres, runs a tick, and **fails loudly (exit 1)** unless an
   incident opened and a triage launch was attempted. A scheduled `sre-drill.yml` workflow runs it.
8. **No weakened existing tests** — every new column/table is additive; the metrics snapshot accessor
   is read-only; the whole feature is default-OFF; the Founder Console gains one optional read seam.

## Seams (pure evaluation + IO orchestrator)

```
src/sre/types.ts        shared types (SloTarget, SloObservation, SloEvaluation, SreDecision, IncidentRecord, ServiceSignal, FailureBundle)
src/sre/slo.ts          pure evaluateSlo(target, observation) → { breached, budgetRemaining, severity }  (availability | latency_p95 | queue_lag)
src/sre/guards.ts       pure predicates (isBreached, budgetExhausted, severityFor, cooldownElapsed)
src/sre/decide.ts       pure decideAlert(input) → { action, reason, severity }   (recover → open → re-page/noop)
src/sre/bundle.ts       pure composeFailureBundle(incident, context) → triage task prompt + runbook links (data, never argv)
src/sre/postmortem.ts   pure draftPostmortem(incident, timeline) → markdown (timeline + 5-whys skeleton)
src/sre/caps.ts         resolveSreCaps(config.sre) → resolved caps + per-service SLO targets (default OFF)
src/sre/engine.ts       SreEngine: start/stop/tickAll/tickWorkspace — injected seams, maintenance+kill gate
src/sre/default.ts      createDefaultSreEngine(logger, sessionManager) — real wiring over /metrics + health + repos
src/sre/drill.ts        pure runChaosDrill orchestration (inject degraded signal → assert incident + triage)
src/sre/drill-cli.ts    `pnpm sre:drill` — fault-inject Redis-down/PG-slow, assert alert fires + triage launches
```

IO seams the engine drives (all injected; tests pass fakes):

- `readSignals(now)` — one `ServiceSignal` per declared service, derived from `/metrics` + health.
- `caps(workspaceId)`, `killSwitch(workspaceId)` — config + #17 reads, mirroring the watchdog wiring.
- `incidents` — the `sre_incidents` store (open lookup by service+slo, open, resolve, attach triage
  session id, attach postmortem path).
- `triage` — the #92 `AutonomyLauncher` (reused verbatim) that launches the triage session.
- `escalator` — `createRequest` into the #13 queue with `actionType: "sre.remediate"` for risky
  remediation of a `critical` incident.
- `notifier` — emit an incident notification (best-effort, never throws).
- `postmortems` — write the drafted markdown under `docs/postmortems/` and return its path.
- `maintenancePaused()` — the #99 `isMaintenanceActive` (fail-open).

## Out of scope (deferred behind seams)

- **Auto-remediation execution.** The loop **diagnoses** (triage agent) and **gates risky remediation
  behind #13**; actually applying a fix (restart a dependency, roll back a deploy) rides the existing
  #73 deploy / #99 restore seams and is a follow-up. The `sre.remediate` approval is where it plugs in.
- **Multi-window / burn-rate alerting (fast+slow).** This slice uses a single rolling window per SLO.
  Google-SRE multi-burn-rate alerts reuse the same `evaluateSlo` and are a natural follow-up.
- **External paging (PagerDuty/Opsgenie).** Notifications use the in-platform #notifications seam +
  the Founder Console; an external transport plugs into the same `notifier` seam.
- **Real queue infrastructure.** "Queue lag" is evaluated generically; production maps it from the #71
  admission in-flight snapshot as a coarse proxy until a real work queue exists.
