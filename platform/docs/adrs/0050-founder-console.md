# ADR-0050: Founder Console — one read-only pane of glass for the daily review

- **Status:** Accepted (owner waived the video gate — issue #104)
- **Date:** 2026-06-10
- **Context issue:** [#104](https://github.com/gagan114662/agent-skills/issues/104) (Premortem #5 —
  compress the irreducible human work into one ~10-minute daily review)
- **Builds on:** [ADR-0013](0013-approvals.md) (human approval gates), [ADR-0049](0049-venture-loop.md)
  (venture scorecards/verdicts), [ADR-0043](0043-stripe-revenue-rails.md) (revenue / willingness-to-pay
  evidence), [ADR-0040](0040-cloud-scale.md) (tenant usage + budget caps + admission snapshot),
  [ADR-0099](0099-disaster-recovery.md) (global maintenance flag), [ADR-0017](0017-autonomy.md)
  (autonomy kill switch). Surfaces in the #18 web console.

## Context

The platform now runs agents 24/7, charges real money, and gates sensitive actions on a human. The
state the owner needs for a daily review — fleet activity, venture pipeline, revenue, budget burn,
the pending human-action queue, and the safety switches — is scattered across several surfaces. The
owner is the irreducible decider for signatures, money, and external posting; the design goal is to
keep them the *decider* without making them the *latency bottleneck*. We want one read that compresses
that scatter, surfaces what needs a human, and makes the decision-SLA (time-in-queue) visible.

## Decisions

1. **A read-only aggregation feature — no new mutation paths.** The console reads; it never writes.
   Approve/reject (#13), kill switch (#17), and maintenance (#99) all flip through their **existing**
   endpoints. The console links to them and shows their current state, but adds no authority. This is
   the single most important boundary: a read pane cannot become a second, weaker control plane.

2. **A `founder-console/` module mirroring the #17/#71/#96 shape: pure core + IO orchestrator +
   thin route.** `aggregate.ts` (`aggregateFounderConsole`) is **pure** — gathered read-structs +
   a clock instant in, the console DTO out, with all derived display logic (pipeline counts, budget
   over/under + utilization, WTP presence, approval queue-age, oldest-first ordering, the attention
   reasons). It is the single source of truth for "what the owner sees", fully unit-tested with no IO.
   `service.ts` is the IO orchestrator: it declares one **read seam per data source**
   (`FleetReader`, `VentureReader`, `RevenueReader`, `BudgetReader`, `ApprovalsReader`,
   `SwitchesReader`), gathers them concurrently, and calls the pure aggregate. `default.ts` wires the
   real repos/managers (`scale.admission.snapshot`, `listEvaluations`, `BillingManager.revenue`,
   `getUsage` + `resolveScaleCaps`, `listRequests({status:"pending"})`, `getControls` +
   `getMaintenanceState`). `routes/founder-console.ts` is a thin `requireIdentity` + `assertWorkspace`
   adapter calling `service.get(wid)`.

3. **Tenant isolation on the route; the maintenance flag is the one global value.** Every per-tenant
   number is gated by `assertWorkspace` (the #19/#3 IDOR discipline), and the cross-tenant 403 is the
   integration regression guard. The global maintenance flag is platform-wide (not tenant data) and is
   read through the same fail-open path the #99 write-gate uses, so a Redis outage reports
   `unavailable` rather than throwing.

4. **Decision-SLA is computed in the pure core.** Each pending approval carries an `ageSeconds`
   (clock instant − `createdAt`), and the queue is returned **oldest-first** — the longest-waiting
   item is the one most likely to be the bottleneck. This delivers the "time-in-queue per item so the
   bottleneck is visible" requirement; the notification/webhook + daily-digest *batching* on top of
   these ages is a follow-up.

5. **No new table, no migration.** The feature is strictly aggregation over existing data, like the
   #71 usage route (route + reads only). The only additive persistence-layer change is a new
   workspace-scoped **read** — `listEvaluations(workspaceId)` on the venture repo (all statuses, for
   the pipeline roll-up) — which adds no schema. ADR-0050 takes the next free ADR slot (ADRs are
   numbered by next-free slot, not by issue).

## Consequences

- **Positive:** One read gives the owner the whole picture; the pure aggregate is trivially testable
  and keeps the route a thin adapter; reusing existing mutation endpoints means zero new authority and
  no duplicated approval/kill/maintenance logic; no migration means no sibling-workspace DB collision.
- **Negative / trade-offs:** The DTO shape and the web `FounderConsoleDto` are kept in lock-step by
  hand (no codegen) — the integration test pins the server shape and the web unit test pins the
  render. The pipeline roll-up reads all of a workspace's venture evaluations per request (acceptable
  at current scale; a counted/indexed roll-up is a later optimization if needed).

## Deferred

- **#15 memory-graph rationale recording** (the premortem's "every approval records a rationale so
  agents learn the founder's judgment"). That is a *write* and belongs on the existing #13
  approval-decision path, not in this read-only console — deferred to keep this slice strictly
  read-only.
- **Batching + notifications/webhook + daily digest** on top of the per-item decision-SLA ages.
- **A persisted console snapshot/audit table** (would be the only thing requiring a migration).
