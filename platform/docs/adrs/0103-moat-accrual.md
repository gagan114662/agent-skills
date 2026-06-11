# ADR-0103 — Moat Accrual

**Status:** Accepted
**Issue:** #103
**Date:** 2026-06-11

## Context

Premortem #4: anything a fleet builds from public knowledge, any fleet can rebuild. The Venture Loop
(#96) scores *fundability* once, at intake — but durable advantage is something a launched venture
must **accrue over time** (proprietary data, switching costs, distribution lock-in, accumulated
evals/skills). Nothing measures whether that accrual is actually happening, so a portfolio of
"funded" ventures can quietly become a portfolio of commodity products. #107 (portfolio kill
discipline) needs a moat signal to act on; the Founder Console (#104) needs to surface ventures that
have stopped compounding.

## Decision

Add a **moat-accrual** subsystem with the same pure-core + IO-orchestrator + config-caps shape as
#96/#71/#117:

1. **Pure scoring (`moat/score.ts`)** — four dimensions, a saturating per-dimension subscore (log
   curve, diminishing returns), a weighted-mean aggregate scaled 0–100, and a pure window-stagnation
   assessment. No IO, no clock of its own — the instant is passed in — so the whole thing is
   unit-tested in isolation.
2. **A per-venture ledger (`moat_ledger`, migration `0103_`)** — concrete accrual rows with
   provenance. The ledger is the audit trail; the score is a pure projection of it. Workspace-scoped
   with `onDelete: cascade`, `venture_idea_id` FK so accruals die with their venture.
3. **A read API (`MoatService`)** the Venture scorecard (#96) and the portfolio tick (#107) consume —
   `scoreVenture` and `portfolioMoat`. Seam-injected so it unit-tests against fakes.
4. **Founder Console flagging (#104)** — ventures with **zero** accrual over a configurable window are
   flagged for attention. This is the shipped consumer of the signal (since #107 is unbuilt).

The gate is **default OFF** (`moat.enabled: false`): a deployment that sets no `moat` block keeps
today's behavior. Recording accruals + scoring always work (read surfaces); only the Console
*attention* flagging is gated, mirroring how #119 evidence *recording* is always-on while the pricer
is gated.

## Alternatives considered

- **Fold moat into the Venture decide gate (block FUND on a moat plan).** Rejected for this slice: it
  changes the #96 gate's behavior and risks regressing its tests. The score is additive and read-only;
  #96 can consume it without the gate depending on it. (The spec's FUND-time moat-plan artifact is a
  natural follow-up that builds on this ledger.)
- **A single magnitude per venture instead of per-dimension.** Rejected: a single number lets one
  dimension (e.g. a big data dump) fake a broad moat. Per-dimension subscores with diminishing returns
  force breadth, matching the premortem's "proprietary data **and** switching costs **and**
  distribution".
- **Linear subscore.** Rejected: linear lets magnitude run away; the log/saturating curve makes the
  first units of accrual matter most and caps each dimension at 10, which is how moats actually behave
  (the 1000th proprietary row is worth less than the 1st).

## Numbering

ADR + migration numbered **0103** (by issue), not by next-sequential, to dodge collisions with sibling
Conductor branches landing their own migrations in parallel — the same discipline as #99/#112/#117.

## Consequences

- One new additive table; `.down.sql` drops it. No change to existing schema.
- New `moat` config block — **must** appear in both `mergeSettings` and `mergeLayers` (a block in only
  one is silently dropped at runtime; the #98 gotcha).
- The Founder Console gains an optional `moat` input; absent ⇒ zeroed moat view (works before the
  subsystem is wired, like the #117 self-healing pane).
