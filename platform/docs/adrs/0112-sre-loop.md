# ADR-0112: SRE Loop — agent on-call (SLOs, alerts, incidents, postmortems)

- **Status:** Accepted (shipped in PR for #112)
- **Date:** 2026-06-10
- **Context issue:** [#112](https://github.com/gagan114662/agent-skills/issues/112)
- **Spec:** [docs/specs/112-sre-loop.md](../specs/112-sre-loop.md)
- **Builds on:** [ADR-0025](0025-cloud-execution.md) (SessionManager / `agent_sessions`),
  [ADR-0017](0017-autonomy.md) (pure `decide`/`guards` + IO orchestrator; kill switch),
  #84/#92 (real sessions via the `AutonomyLauncher` seam), [ADR-0040](0040-cloud-scale.md)
  (`tenant_usage` budget), [ADR-0013](0013-approval-gates.md) (approvals queue),
  [ADR-0099](0099-disaster-recovery.md) (maintenance Redis flag + DR runbook),
  [ADR-0050](0050-founder-console.md) (Founder Console), [ADR-0105](0105-fleet-watchdog.md)
  (the supervisor pattern this clones), and the #19 `/metrics` + health probes.

> **Numbering note.** Spec/migration/ADR all use the `0112` slot (the issue number), per the project's
> by-issue numbering convention (see ADR-0099's note) — chosen to dodge sibling-workspace collisions in
> the shared migration sequence.

## Context

The platform can build and run agents 24/7, but it cannot **operate** the resulting services. There is
a `/metrics` registry (#19) and health probes (`/healthz`/`/readyz`), but nothing watches them: a
latency regression or an availability dip pages no one, triages nothing, and leaves no trace. A fix
depends on a human happening to look at a Grafana board. For an autonomous fleet that is the unsolved
half — "coding is the easy part."

The hard parts are not "send an alert". They are: (a) turning raw counters into an **SLO judgment with
an error budget** that is pure and testable; (b) a **durable incident** so a breach is a tracked thing
with a lifecycle, not a log line; (c) putting an **agent on triage** within the same guardrails every
other launch obeys (kill switch, budget, maintenance) and never letting it auto-run **risky
remediation** without #13 approval; (d) leaving a **written postmortem** linked where the owner reads;
and (e) **proving the path works** with a scheduled chaos drill — all **default-OFF** so it changes
nothing until an operator declares SLOs.

## Decisions

1. **SLO evaluation is pure arithmetic, unit-tested per kind.** `evaluateSlo(target, observation)`
   handles `availability` (success-ratio target; budget burns as the ratio falls below target),
   `latency_p95` (breach when observed p95 exceeds the target ms), and `queue_lag` (breach when lag
   exceeds the target seconds). It returns `{ breached, budgetRemaining (0..1), severity }`. No IO, no
   clock — the #17/#105 pure-core pattern, so every branch and boundary is a unit test.

2. **The decision is pure; the engine does the side effects.** `decideAlert(input)` returns one of
   `open | resolve | notify | escalate | noop` with a `reason`, in a deliberate order (recovery of an
   open incident before a fresh breach; re-page only past a cooldown). The engine opens the incident
   row, launches triage, enqueues the #13 remediation, notifies, and drafts the postmortem on resolve —
   the **choice** lives in `decide.ts`, the **effects** in `engine.ts`, exactly like `decideRevival`.

3. **Alert evaluation runs off the metrics we already expose — no vendor.** The production signal
   source derives availability from `http_requests_total` (success ÷ total) and p95 from the
   `http_request_duration_seconds` histogram via a new **read-only** `snapshotMetrics()` accessor on
   the #19 registry, plus per-dependency health from the same `pingDb`/`pingRedis` the `/readyz` probe
   uses. The pure observation mapping is unit-tested; no Prometheus server, no SaaS, no new dependency.

4. **The SRE tick is cross-process, on infrastructure time, gated like every other loop.**
   `SreEngine.start(intervalMs)` is a no-op when `intervalMs ≤ 0` (default `0` = OFF), mirroring
   #17/#96/#105. `tickAll()` checks the #99 maintenance flag **before any signal read** (fail-open) and
   skips the whole pass during a maintenance window; each per-workspace pass returns immediately when
   the #17 kill switch is engaged or when `sre.enabled` config is false. SLO targets are declared in
   the layered config (#58), default empty ⇒ nothing to evaluate.

5. **Incidents are durable and deduped by `service+slo`.** `sre_incidents` persists one row per breach:
   the service, the SLO kind, severity, observed/target/budget, the triage session id (soft ref), the
   postmortem path, and the lifecycle timestamps. A **partial unique index** on
   `(workspace_id, service, slo_kind) WHERE status <> 'resolved'` guarantees one open incident per
   service+slo — a sustained breach never floods the queue; recovery flips the row to `resolved`,
   freeing the slot.

6. **Incident response reuses the #92 `AutonomyLauncher` verbatim, with a data-only failure bundle.**
   Opening an incident launches a triage session for the incident's workspace through the same launcher
   the autonomy/watchdog paths use — so it passes the **same** #71 admission chokepoint and adds no new
   launch authority. `composeFailureBundle(incident, context)` builds the triage prompt as **data,
   never argv** (the #50 injection-safety contract): the breached SLO + observed/target, the recent
   trace/log context, the last deploys (from the #73 `deployments` repo), and the **#99 DR runbook**
   link for data-plane incidents.

7. **Risky remediation is gated behind #13; the loop never auto-fixes.** A `critical` incident (error
   budget exhausted) enqueues a `createRequest({ actionType: "sre.remediate", … })` into the existing
   `approval_requests` table — the Founder Console surface — so a human authorizes any state-changing
   fix. The triage agent **diagnoses**; applying a remediation rides the #73 deploy / #99 restore seams
   behind that approval. The loop's autonomous reach is detect → triage → document, nothing destructive.

8. **Postmortems are a drafted artifact, linked from the Founder Console.** `draftPostmortem(incident,
   timeline)` (pure) renders a timeline + 5-whys-skeleton markdown; on resolve the engine writes it
   under `docs/postmortems/` via a `PostmortemWriter` seam and records the path on the row. The Founder
   Console (#104) gains **one optional read seam** (`postmortems`) that lists recent resolved incidents
   with a postmortem path — read-only, additive, defaulting to empty so the console is unchanged when
   the loop is off.

9. **Game days prove the path, like `dr:drill`.** `pnpm sre:drill` injects a Redis-down / PG-slow
   signal against a throwaway Postgres, runs one tick, and **fails loudly (exit 1)** unless an incident
   opened and a triage launch was attempted — so a broken alert pipeline is caught on a schedule, not
   during a real outage. A `sre-drill.yml` workflow runs it on cron + `workflow_dispatch`.

## Consequences

- **Default-OFF, additive, no weakened tests.** Double opt-in (interval `0` + `enabled:false`), a new
  table/migration (`0112`) with no change to existing schemas, a read-only metrics accessor, and one
  optional Founder Console read seam. Existing fakes and tests are untouched.
- **Bounded blast radius.** The loop's autonomous actions are detect, open-incident, launch-triage,
  notify, and draft-postmortem — all reversible/observational. Every state-changing remediation is a
  human-approved #13 action; every launch passes the same #71 admission as any other.
- **Observability.** `sre_ticks_total` / `sre_actions_total{action}` join the #19 registry; the durable
  `sre_incidents` rows + the `docs/postmortems/` artifacts are the incident story.
- **Deferred (behind seams):** auto-remediation execution (the `sre.remediate` approval is the plug),
  multi-burn-rate alerting (reuses `evaluateSlo`), external paging (the `notifier` seam), and a real
  work-queue lag source — each plugs into an existing seam without reshaping this slice.
