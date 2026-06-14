# ADR-0187: Venture Factory — idea → validated → launched venture on autopilot

- **Status:** Accepted (shipped in PR for #187)
- **Date:** 2026-06-13
- **Context issue:** [#187](https://github.com/gagan114662/agent-skills/issues/187)
- **Premortem:** [#200](https://github.com/gagan114662/agent-skills/issues/200) (the standing "necessary
  but not sufficient" list — this factory is where its load-bearing rules become code: §1 edge gate +
  make-one-profitable-first, §2 external-receipts-only metrics, §4 reversibility/MONEY boundary).
- **Builds on:** [ADR-0013](0013-approval-gates.md) (the #13 approval queue + `createRequest` — the
  MONEY/launch gate + Slack #170 one-tap), [ADR-0017](0017-autonomy.md) (the pure-`decide` /
  IO-orchestrator / config-default-OFF pattern + the per-workspace kill switch), [ADR-0049](0049-venture-loop.md)
  (the #96 venture loop the candidates graduate into), [ADR-0107](0107-portfolio-lifecycle.md) (the
  SUNSET gate the kill/archive loop reuses), [ADR-0100](0100-insight-miner.md) (the multiplicative
  ranking the scanner reuses), [ADR-0123](0123-marketing-fleet.md)/[ADR-0138](0138-pop-identity-channels-deploy.md)
  (the idempotent seven-department fleet seed the bootstrap reuses), [ADR-0191](0191-verification-layer.md)
  (the reversibility classes the bootstrap steps are tagged with).

> **Numbering note.** Migration / ADR both use the `0187` slot (the issue number), per the project's
> by-issue numbering convention (ADR-0099's note) — chosen to dodge sibling-workspace collisions in the
> shared migration sequence.

## Context

Until now the company could *run* ventures (the #96 loop scores a hand-submitted idea; #123/#138 seed a
fleet into a workspace someone created by hand) but it could not *start* one. There was no pipeline from
opportunity to live venture. The owner directive (#187): the company must be able to START businesses.

But the premortem (#200) is explicit that a zero-cost execution machine that reads the same trends as
everyone else will fail. So the factory cannot be "scan → spin up a tenant". It must answer the standing
failure modes *before* it spends a cent or registers a name.

## Decision

A new `venture-factory/` module orchestrates the existing seams. The decision logic is **pure** (one
source of truth per gate, every path unit-tested); the service is a thin IO orchestrator over injected
seams (so it runs against fakes in tests and the real repos in `default.ts`). Everything is **default
OFF** behind `ventureFactory.enabled` and **owner-workspace-first** (`ownerWorkspaceOnly: true`).

### 1. Opportunity scanner (AC1)

`scanner.ts` scores a lens/scout-filed candidate **multiplicatively** — source authority × freshness ×
pain × competition absence (the #100 idea verbatim): a zero on any axis zeroes the candidate. Scoring is
pure; the continuous tick (`engine.ts`, started only when `VENTURE_FACTORY_INTERVAL_MS > 0`) advances
`scanned` candidates and is gated inside the service by enabled / owner-scope / kill switch + a #71
budget pre-charge.

### 2. The EDGE GATE (premortem FM#1 — the load-bearing rule)

`edge-gate.ts` `decideEdgeGate` is the hard precondition to launch: **no venture is validated without a
falsifiable distribution / data / relationship edge.** A claim qualifies only if it is one of the three
real edge classes, carries a concrete *disproof test* (an edge you cannot falsify is a hope), and is
backed by an EXTERNAL receipt or an owner-attested secret (self-asserted "we think competitors can't"
never counts — FM#2). `validate` runs this FIRST; a candidate that fails is `killed`, never validated —
no smoke test, no spend.

`decideFactoryAdmission` enforces the second sentence of FM#1: **make ONE venture profitable end-to-end
before scaling** — a new bootstrap is barred while a venture is active and none is *externally*
profitable, plus a hard concurrency cap.

### 3. Validation on a HARD budget cap (AC2, premortem FM#2)

`validation.ts`: `decideValidationSpend` is a hard cap checked before every charge (a runaway smoke test
is impossible). `scoreFromReceipts` builds the scorecard from EXTERNAL receipts ONLY (signed signups /
ad-spend records); CAC and the 0–100 score are DERIVED and carry the `UNVERIFIED` label and never
kill/scale alone. `decideValidationOutcome` PROMOTE always rests on a real external signup floor under a
CAC ceiling. The smoke-test landing + waitlist ships via the #153 marketing-site patterns as a gated
`external.send`.

### 4. Idempotent bootstrap + the MONEY boundary (AC3 + AC4, premortem FM#4)

`bootstrap.ts` `planBootstrap` produces the ordered, **idempotent** steps (every step carries an
`idempotencyKey`, so a re-run is a no-op, like #138). `classifyMoneyBoundary` is the single source of
truth for the MONEY boundary: domain purchase, ad-spend start, and payment-method use are `money`
(irreversible — FM#4) and each queues as its own owner **#13/Slack** decision under a dedicated action
kind (`venture.domain_purchase` / `venture.ad_spend` / `venture.payment_method`); everything else
(reversible — workspace, brand kit, landing, repo/deploy, budget caps, the #138 fleet seed) runs
autonomously. The single owner go/no-go that *starts* a venture is `venture.bootstrap`. Naming runs
through a deterministic `namingPrecheck` (syntax/blocklist, no network) plus a clean
`NamingAvailabilityChecker` seam whose default stub answers "unknown" so domain/trademark are always
parked for a human — the clean interface #196's legal-compliance pack will plug into.

### 5. Kill/scale loop (AC5)

The kill decision reuses the #107 portfolio SUNSET gate (owner-approved); `archive` then tears the
factory venture down cleanly (status `archived`, artifacts retained, schedules cancelled via the
archiver seam).

### 6. Premortem panel (premortem #200 AC2)

`founder-briefings/aggregate.ts` gains a pure `composePremortemPanel`: edge coverage %, externally-
verified metrics %, irreversible-action count, owner attention spend vs budget, rubber-stamp rate, and
override rate — with `flags` that make it impossible for the brief to read "all green" while an edge is
missing or metrics are self-reported.

## Schema

Migration `0187_venture_factory.sql` (+ `.down.sql`, verified up/down on a throwaway DB) adds three
`workspace_id`-scoped (onDelete cascade) tables: `factory_candidates` (scored opportunity + edge claims
+ edge status), `factory_validations` (one experiment per candidate — the HARD cap, external receipts,
derived UNVERIFIED scorecard), `factory_ventures` (idempotent, one per candidate). Cross-entity links
(`venture_idea_id`, `approval_request_id`) are soft refs (no FK), per the #197 persistence discipline.

## Consequences

- **Default OFF + owner-first.** A deployment that sets no `ventureFactory` config runs no scanner,
  ships no smoke test, bootstraps nothing — today's behavior is byte-for-byte unchanged. The first blast
  radius is the owner's own workspace.
- **The edge gate is non-negotiable.** It is a pure function with exhaustive tests; a high opportunity
  score never bypasses it. This is the single most important guardrail in the factory.
- **No self-reported metric drives a decision.** The validation scorecard is external-receipts-only; the
  scaling gate waits for an *external* profit signal (the default reader returns 0 until app.ts injects a
  billing-backed one — conservative by construction).
- **Money is never autonomous.** Every irreversible/MONEY step is an owner #13 decision; only reversible
  steps run without a human.
- **Deferred (clean seams exposed):** the live `NamingAvailabilityChecker` (WHOIS/trademark), the
  real #138 fleet-seed / #98 profitability / #107 archiver injections in `app.ts`, and the live lens/scout
  candidate sources. Each is an injected seam with a safe default, not a stub baked into the logic.
