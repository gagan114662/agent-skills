---
name: analytics-provenance-ladder
kind: reference
domain: analytics
description: Honest, receipt-backed metrics — the provenance ladder, leading vs lagging signals, and causal attribution.
---

# Provenance Ladder

A number with no external receipt is a guess wearing a suit. Before you report
any figure, ask: *what real-world event does this trace back to — a real click,
a real payment, a real session?* If you cannot name the event and where it was
recorded, you are reporting a story, not a metric.

## The ladder (trust top to bottom)

1. **Governed semantic layer** — metrics defined once in a versioned, reviewed
   model (dbt/LookML/cube), where "active user" and "MRR" have a single SQL
   definition everyone queries. Trust this. Numbers are reproducible and
   consistent across every dashboard. **Always prefer this source.**
2. **Curated** — a vetted table or report owned by a named team, with a known
   refresh schedule and documented transforms (e.g. a Stripe→warehouse sync, a
   GA4 export). Trustworthy, but verify freshness and that the definition matches
   the semantic layer. Reconcile, don't assume.
3. **Raw / ad-hoc fallback** — a hand-pulled CSV, an API call you made yourself,
   a screenshot of an analytics UI, a number someone pasted in chat. Use *only*
   when 1 and 2 are unavailable, and **always flag it as unverified** with its
   source and timestamp. See `raw-fallback-protocol.md`.

Rule: **never silently mix levels.** If a report blends governed MRR with a
hand-counted signup figure, label each. The reader must know which numbers are
load-bearing and which are scaffolding.

## The external-receipt test

A metric is *grounded* only if it derives from an externally observable event:

- A **real click** logged by the ad platform or your server.
- A **real payment** confirmed by Stripe/the processor (not "intended" revenue).
- A **real session** with a server-side or first-party event.

Internal estimates, "projected" numbers, modeled attributions, and anything a
human typed without a source are **derived, not observed** — fine as inputs,
never as the headline figure. If the receipt can be reached and re-read (a live
URL returning 2xx, a Stripe charge id, a webhook payload), the number is real.
If it cannot be re-derived from a receipt, treat it as an estimate and say so.

## Leading vs lagging indicators

- **Lagging** indicators report what already happened — revenue, churn, NRR.
  They are trustworthy and final but you cannot act on them; the period is over.
- **Leading** indicators predict the lagging ones — activation rate, trial
  starts, pipeline created, demo bookings. They are noisier but *actionable now*.

Pair them: every lagging goal needs a leading metric you can move this week, and
every leading metric needs a known historical correlation to a lagging outcome.
A leading indicator with no demonstrated link to revenue is a vanity metric in
disguise.

## Causation vs correlation (attribution)

Correlation is the default failure mode of marketing analytics. "We launched the
blog and signups rose" ignores seasonality, a concurrent ad push, and PR. Rank
attribution claims by causal strength:

1. **Randomized experiment (A/B test)** — the gold standard. A holdout group did
   *not* get the treatment; the difference is causal. Require sufficient sample
   and a pre-registered metric and window.
2. **Quasi-experiment** — geo holdouts, difference-in-differences, regression
   discontinuity. Causal-ish when a clean experiment is impossible.
3. **Multi-touch / model-based attribution** — useful for budget allocation,
   *not* proof of causation. State the model and its assumptions.
4. **Last-touch / "it went up after we did X"** — correlation. Never report as
   cause without a caveat.

## When to trust a number — concrete rules

- It comes from the governed semantic layer (level 1), **or** you can name and
  re-read its external receipt.
- Its definition (numerator, denominator, window) is written and matches every
  other place it appears.
- Its freshness is known and stated.
- Any causal claim attached to it is backed by an experiment or labeled as
  correlation.

If a number fails these, report it with an explicit `unverified` flag and its
provenance — do not launder it into a confident headline.

made by robots, steered by humans.
