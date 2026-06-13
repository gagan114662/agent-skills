# ADR-0194: Finance Ledger — books that close themselves, money decisions in one queue

- **Status:** Accepted (shipped in PR for #194)
- **Date:** 2026-06-13
- **Context issue:** [#194](https://github.com/gagan114662/agent-skills/issues/194)
- **Premortem:** [#200](https://github.com/gagan114662/agent-skills/issues/200) — every money
  number must come from an external receipt; estimates are labeled UNVERIFIED and never drive
  kill/scale alone; money movements are IRREVERSIBLE so they are pre-committed or human-gated,
  never reviewed post-hoc.
- **Builds on:** [ADR-0043](0043-stripe-revenue-rails.md) (`revenue_events` — verified inbound
  webhooks, the `BillingStore` seam, the INBOUND-ONLY money split), [ADR-0040](0040-cloud-scale.md)
  (`tenant_usage.estimated_cost_cents` — model spend is an *estimate*, rate defaults to 0),
  [ADR-0013](0013-approval-gates.md) (the one approval queue + recorded-only sensitive executors),
  [ADR-0107](0107-portfolio-lifecycle.md) (per-venture P&L stub + the "no per-venture split today"
  finding), [ADR-0173](0173-founder-briefings.md) (the weekly founder report seam + the pure-core /
  IO-orchestrator / one-reader-per-source / default-OFF / by-issue-numbering pattern this mirrors
  wholesale), [ADR-0170](0170-slack-native-integration.md) (one-tap Slack rides any #13 pending
  approval automatically), [ADR-0099](0099-disaster-recovery.md) (maintenance pause + by-issue
  migration numbering).

> **Numbering note.** Migration/ADR both use the `0194` slot (the issue number), per the by-issue
> numbering convention (ADR-0099's note) — to dodge sibling-workspace collisions in the shared
> migration sequence. Do **not** renumber to the next sequential slot.

## Context

P&L today is a weekly *estimate*, not books. Revenue lives workspace-level in `revenue_events`
(#98); model spend lives workspace-level in `tenant_usage` (#71, an estimate that is 0 until an
operator sets a rate); there is **no** infra/ad-spend/subscription/Stripe-fee cost source at all,
and **no per-venture revenue/cost split** (ADR-0107 says so explicitly). The owner's directive:
the owner handles money **decisions**; the system must handle money **accounting** — continuously,
per venture, with a monthly close and a runway forecast, and with every money decision in one
ordered queue.

The premortem (#200) is the governing constraint, and it makes the naive version wrong:

- **Self-reported metrics are fiction.** A ledger that trusts an internal "we made $X" number is
  worse than no ledger. Balances must be reconstructable from **external receipts** (Stripe events,
  payout/delivery webhooks). Anything derived from an internal estimate (compute-seconds × rate)
  must be **labeled UNVERIFIED** and must never drive a kill/scale decision on its own.
- **Money is IRREVERSIBLE.** A disbursement/refund/transfer cannot be undone by a post-hoc review.
  So the ledger may **never** move money autonomously. Outbound money is pre-committed or
  human-gated through the existing #13 queue, recorded-only — exactly the discipline `billing.refund`
  already follows (ADR-0043: structurally absent from the provider seam, default-sensitive,
  `{recorded:true, executed:false}`).

## Decision

Add a **`finance/` accounting layer** that mirrors the #173 reporting layer wholesale — a pure
core, an IO orchestrator with one injected store/reader seam per source, `default.ts` wiring over
existing repos, thin tenant-scoped read routes, an opt-in scheduled engine — plus **two** durable
tables (the ledger + the closed books). **Default-OFF, owner-workspace-first.**

1. **Every entry is sourced from an external receipt.** The pure core turns inputs into
   `LedgerPosting`s tagged with `source` + `source_ref` + `verified`:
   - a Stripe `revenue_event` → a **verified** `credit` (`source: stripe_event`, ref =
     `providerEventId`);
   - a `tenant_usage` window's `estimated_cost_cents` → an **UNVERIFIED** `debit`
     (`source: tenant_usage`, ref = the `YYYY-MM` window key) — honestly labeled, because it is an
     estimate (ADR-0040), not a bill;
   - a manually-entered cost (infra/ad/subscription/domain the owner records) → an **UNVERIFIED**
     `debit` (`source: manual`) until a real receipt webhook backs it.
   The ledger is **double-entry-ish**: `direction ∈ {credit, debit}` + a `category`, with
   `net = Σcredit − Σdebit`. Amounts are always non-negative integer cents; the sign is the
   direction. Posting is **idempotent** — upsert on `(workspace_id, source, source_ref)` — so the
   engine can re-post on every tick and a webhook can never double-count (the same dedupe discipline
   as `revenue_events`).

2. **Books that close themselves.** `composeClosePack` is a total function over a period's entries:
   revenue, cost, **`verified_cost_cents`** (the externally-backed subset), `net`, the cash
   position, the unit economics, and **`verified_share_bps`** — the share of the period's money
   magnitude that is externally verified, the premortem's "% externally-verified metrics" surfaced
   per close. The engine refreshes the current period's `finance_close_packs` row on every tick and
   the books "finalize" naturally when the period ends and no new entries arrive. Unit economics
   (CAC / LTV / margin) are computed **only** from inputs that exist; missing customer counts yield
   `null`, never a fabricated number.

3. **Forecast + runway predict the breach before it happens.** `runwayForecast` is pure: monthly
   burn from the recent periods, runway days from the cash position, and the **period the balance
   is predicted to breach** a floor — so the on-track/at-risk header is real math, not a vibe. The
   forecast separates `verifiedNetCents` from `estimatedNetCents` so an at-risk signal can state how
   much of it rests on unverified estimates.

4. **One money queue = the #13 queue, reused — not a second one.** Every money decision already
   flows through `approval_requests` and is already ordered by #173's `composeDecisionQueue` and
   delivered one-tap via #170. This PR adds the missing money-movement action,
   **`finance.disbursement`**, to the default-sensitive list (ADR-0013): it is **always** human-gated
   and, like `billing.refund`, **recorded-only** — the executor performs no transfer
   (`{recorded:true, executed:false}`); the owner moves the money by hand. A pure
   `recommendMoneyDecision` annotates a money decision with its **runway impact** (runway days after
   the spend) and a `approve | caution | hold` recommendation, so the queue carries amount + impact +
   recommendation as the issue requires. No money decision is ever auto-created or auto-approved.

5. **Attached to the weekly founder report (#173), additively.** `FinanceService.weeklyFinanceSection`
   returns the per-venture close packs + verified share + runway header. It is wired into
   `composeWeeklyReport` as an **optional** input: when finance is OFF (or unwired) the input is
   `undefined` and the report renders byte-for-byte as before, so every existing briefings test stays
   green (the #114 composable-overlay discipline).

6. **Default-OFF, owner-workspace-first; risk is structurally bounded.** The new capability is the
   engine that writes ledger/close rows + the `finance.disbursement` action. `finance.enabled`
   defaults `false`: the engine interval is `0` (no tick), the read routes answer `409`, and the
   weekly section is omitted. It is enabled owner-workspace-first via the managed config layer
   (#58). Even fully enabled, the layer **cannot move money** — there is no outbound provider call
   anywhere in `finance/`, and `finance.disbursement` stays human-gated and recorded-only.

## Schema (migration 0194)

- **`finance_ledger_entries`** — the continuous per-venture ledger. `workspace_id` (tenant
  boundary, #3), nullable `venture_idea_id` (workspace-level when null; attribution improves over
  time), `direction` (`credit|debit` CHECK), `category`, `amount_cents` (≥ 0 CHECK), `currency`,
  `verified bool`, `source` (`stripe_event|tenant_usage|manual` CHECK), `source_ref`, `occurred_at`,
  `memo`, `created_by_member_id`. Idempotency: `UNIQUE (workspace_id, source, source_ref)`.
- **`finance_close_packs`** — the closed monthly book per venture-scope + period. `workspace_id`,
  nullable `venture_idea_id`, `period_key` (`YYYY-MM`), `currency`, `revenue_cents`, `cost_cents`,
  `verified_cost_cents`, `net_cents` (signed), `verified_share_bps`, `entry_count`,
  `unit_economics jsonb`, `closed_at`. One book per scope+period via a `COALESCE(venture_idea_id, …)`
  unique index (NULL = the workspace-level book).

Both are written **only** by the finance layer's own engine/route; like #173's `founder_briefings`,
this is bookkeeping about money the company already received/spent, not new authority over billing.

## Consequences

- The ledger is honest about what it does and doesn't know: a close pack's `verified_share_bps`
  tells the owner exactly how much of the books rests on external receipts vs. internal estimates.
  Until infra/ad/Stripe-fee receipt webhooks land, model spend is the only cost signal and is
  UNVERIFIED — the number is shown, labeled, and kept out of any autonomous kill/scale path.
- Per-venture attribution is best-effort in v1 (revenue/cost are workspace-level today, per
  ADR-0107); the schema carries `venture_idea_id` so attribution can be backfilled without a
  migration, and a `VentureAttributor` seam lets a later PR map sessions/payment-links to ventures.
- Real outbound money (`stripe.refunds.create`, payouts) behind the `finance.disbursement` gate is a
  deliberate future ADR — never an autonomous call.

## Alternatives considered

- **A second decision queue for money.** Rejected — it would split the owner's attention and
  duplicate #13/#173. The premortem budgets owner attention; one ranked queue is the whole point.
- **Trusting `tenant_usage` as the P&L cost line unlabeled.** Rejected by the premortem: it is an
  estimate (rate defaults to 0). It is posted as an UNVERIFIED debit and reported as such.
- **Letting the engine execute approved disbursements.** Rejected — money is irreversible;
  recorded-only matches `billing.refund` and keeps blast radius at zero.
