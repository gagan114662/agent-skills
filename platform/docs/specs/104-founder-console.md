# Spec: Reload Platform — Founder Console: one read-only pane of glass (Issue #104)

> Implements [#104](https://github.com/gagan114662/agent-skills/issues/104). Premortem #5 — legal
> personhood, signatures, money, and external posting bind to the human; that can't be removed, but it
> CAN be compressed so the human is never the latency bottleneck. **Builds on** #13 (approvals),
> #96 (venture loop scorecards/verdicts), #98 (Stripe revenue / willingness-to-pay evidence), #71
> (tenant usage + budget caps + admission snapshot), #99 (maintenance flag), #17 (autonomy kill
> switch), and the #18 web console. Lifecycle: **DEFINE** artifact (`spec-driven-development`) →
> atomic plan → TDD → ADR → one PR. **Video gate waived by the owner.**

## Objective

**What:** A single Founder Console view — and the read-only aggregation endpoint behind it — that
gives the owner everything they need for a ~10-minute daily review in one place:

1. **Fleet status** — live in-flight sessions (tenant + fleet) and sessions started this window.
2. **Venture pipeline (#96)** — scorecards/verdicts rolled up: how many ideas are active, FUNDed,
   KILLed, and ESCALATEd (the borderline calls awaiting human judgment).
3. **Revenue (#98)** — totals, payment count, and the **willingness-to-pay evidence** count (the
   strongest fundability signal: real money changed hands).
4. **Budgets** — current-window `tenant_usage` (sessions, compute, estimated cost) against the
   resolved budget cap, with an over-budget flag.
5. **Pending #13 approvals** — the queue of human actions (autonomy completions, external sends,
   outbound money, venture escalations), each with a **time-in-queue (decision-SLA) age** so the
   bottleneck is visible.
6. **Kill / maintenance switches** — the per-workspace autonomy kill switch and the global
   maintenance flag, surfaced read-only.

The view also computes an **attention** summary: a single boolean + a list of human-readable reasons
("3 pending approvals", "over budget", "kill switch engaged", "maintenance mode active") so the owner
sees at a glance whether the platform needs them right now.

**Why:** The platform runs agents 24/7 (#17/#84/#96), charges real money (#98), and gates sensitive
actions on a human (#13). Today the owner must visit several surfaces to learn the fleet's state and
what needs them. The Founder Console compresses that scatter into one read so the irreducible human
work fits a single daily review — the human stays the *decider*, never the *latency bottleneck*.

**Who:** The founder/owner (Gagan) doing a daily review; an operator checking fleet health and budget;
anyone who must see — without mutating — the pending human actions and the safety switches.

### Scope boundaries (explicit, from the build constraints)

- **Read-only aggregation only.** The console adds **no new mutation paths**. Approving/rejecting an
  item, flipping the kill switch, and flipping maintenance all happen through their **existing**
  endpoints (#13 approval decisions, #17 autonomy controls, #99 maintenance route). The console links
  to those; it never duplicates their authority.
- **Tenant isolation on every route.** `GET /workspaces/:wid/founder-console` applies `requireIdentity`
  + `assertWorkspace` (the #19 guard), so a caller only ever sees their own tenant's numbers; the
  global maintenance flag is the one platform-wide value shown (it is not tenant data).
- **Pure decision/aggregation module + IO orchestrator seam** (the #17/#71/#96 shape): a pure
  `aggregate.ts` composes the gathered read-structs into the console DTO and derives the display flags
  (over-budget, attention reasons, queue ages, pipeline counts); an IO `service.ts` gathers via
  injected read seams; `default.ts` wires the existing repos/managers. No new table, **no migration**
  (the feature is strictly aggregation over existing data).
- **No memory-graph writes in this slice.** #104's premortem mentions recording an approval rationale
  to the #15 memory graph; that is a *write* and lives on the existing approval-decision path, not in
  this read-only console. Deferred — see the ADR's "Deferred" section.

### Acceptance criteria (BUILD/TDD)

- `aggregateFounderConsole(input)` is **pure** and deterministic: given gathered read-structs + a
  clock instant, it returns the console DTO. Unit-tested branch-by-branch (pipeline counts, budget
  over/under + utilization, WTP presence, approval queue-age + oldest-first ordering, every attention
  reason, the no-attention case).
- `GET /workspaces/:wid/founder-console` returns the aggregated DTO for the caller's workspace, 401
  unauthenticated, **403 cross-tenant** (the regression guard), on **real Postgres** (integration).
- The console surfaces in `apps/web` as a "Founder" tab: a presentational dashboard (pure, unit-tested
  against the DTO) fed by a view-local container that fetches `api.getFounderConsole(wid)`.
- `pnpm -C platform typecheck && lint && test && test:integration` are green; no existing test is
  weakened.

## Non-goals

- No new mutation endpoints (approve/kill/maintenance reuse existing routes).
- No new persistence/table/migration; no snapshot/audit table in this slice.
- No notifications/webhook/digest batching engine (the issue's batching is a follow-up; the
  decision-SLA *age* per item — the input to prioritization — is delivered here).
- No #15 memory-graph rationale recording (a write; deferred to the approval-decision path).
