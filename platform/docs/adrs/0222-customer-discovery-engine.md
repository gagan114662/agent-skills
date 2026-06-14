# ADR-0222: Customer Discovery Engine — product + channel signals → a ranked who-to-reach-out-to-now queue

- **Status:** Accepted (shipped in PR for #222)
- **Date:** 2026-06-14
- **Context issue:** [#222](https://github.com/gagan114662/agent-skills/issues/222)
- **Answers to:** [#200](https://github.com/gagan114662/agent-skills/issues/200) (the standing premortem —
  "plans are not customers"; signals must be real receipts, scores stay UNVERIFIED, no PII; see "Premortem").
- **Builds on:** [ADR-0102](0102-growth-loop.md) (the `growth_events` funnel this emits into so the
  founder-console growth panel reads non-zero), [ADR-0050](0050-founder-console.md) (the read-only console
  the GTM pipeline pane plugs into via the established optional-reader seam),
  [ADR-0189](0189-acquisition-execution.md) (the acquisition module whose pure-decide / caps / default
  layering this mirrors), [ADR-0101](0101-demand-validation-rails.md) (the self-vs-external evidence
  discipline — only an `external_ref` makes a metric verified), [ADR-0099](0099-disaster-recovery.md)
  (by-issue migration numbering).

> **Numbering note.** Migration + ADR use the `0222` slot (the issue number), per the by-issue convention
> (ADR-0099's note), to dodge sibling-workspace collisions in the shared sequence.

## Context

Dogfooding ipop showed the founder-console growth panel reading all zeros (acquisition 0, conversion 0,
experiments 0, external-posts 0). The cause is structural: there is **no signal layer** turning a venture's
real product usage + connected channels into a ranked prospect queue, and `growth_events` has exactly one
writer (the manual ingest route) that nothing calls. A launched venture therefore generates **no pipeline**
— and discovery (reach out → they reach back) is exactly where most companies fail for lack of pipeline.

The pattern to copy is the Wispr Flow "money machine": a Customer Discovery Engine wired to product-usage
analytics + every marketing channel. The owner DEFINES what a "power user" is; the engine detects
product-qualified signals (power-user thresholds, usage trending up, pricing-page visits, role match) and
the moment one fires it knows *who* to reach out to. There is no human in the discovery loop.

The premortem (#200) sets the boundaries:

- **Real receipts only.** A signal must be a real product/channel event — never fabricated. The signal
  store holds an OPAQUE `prospect_key` (no PII; emails/identifiers are rejected at ingest).
- **UNVERIFIED until externally confirmed.** A conversion-likelihood score is a *prediction*. It is always
  labeled `UNVERIFIED`; only a signal carrying a non-empty `external_ref` (a real outside reference, e.g. a
  Stripe event id) is treated as verified. A prediction may never alone drive a kill/scale decision.
- **READ-ONLY.** This issue ranks and surfaces; it **never sends**. Outreach (and its owner-gated sends)
  lives in #225. A clean, documented contract (`discovery/contract.ts`) exposes the queue + PQL stream so
  the decision-maker resolver (#223) and the outreach engine (#225) consume a stable seam.

## Decision

A new `discovery/` module mirroring the acquisition (#189) layering — pure core in `score.ts`, IO
orchestrator in `service.ts`, config-resolved `caps.ts`, production wiring in `default.ts` — over four new
`discovery_*` tables (a non-governed prefix, so the #155 metric-surface colocation check is not tripped):

1. **`discovery_signal_defs`** — the owner-defined qualifying signals (kind + threshold + window + role +
   weight). The owner DEFINES "product-qualified".
2. **`discovery_signals`** — the signal store: one real product/channel receipt per row. `prospect_key` is
   opaque; `external_ref` is the verification anchor.
3. **`discovery_pql_events`** — a PQL fires the moment real signals satisfy a definition. Idempotent per
   (workspace, prospect, def). `score` is the 0–100 UNVERIFIED likelihood; `verified` is true only when an
   externally-attributed conversion grounded it.
4. **`discovery_pipeline_entries`** — the 5-stage GTM pipeline membership (outreach → discovery →
   conversion → onboarding → post_sales), idempotent per (workspace, prospect, stage).

**The flow.** `ingestSignal` records a real receipt, then re-evaluates the owner's definitions for that
prospect: a first-seen prospect emits a growth `acquisition`; each new (prospect, def) qualification emits a
PQL event, enters the prospect into the `outreach` GTM stage, and emits a growth `activation`; an
externally-grounded `conversion` receipt advances the `conversion` stage (verified) and emits a growth
`conversion`. So the **founder-console growth panel lights up with event-driven counts**, never placeholders
— through the existing `GrowthService.recordEvent` seam (the only writer of `growth_events`), so the console
score stays consistent.

**The reads (READ-ONLY).** `rankProspects` produces the daily ranked discovery queue — the top-N prospects
to reach out to now, each carrying its qualifying definition(s) + signal kind(s) + an UNVERIFIED likelihood
score. `pipelineMetrics` rolls the entries into per-stage counts + stage-to-stage conversions, surfaced both
on the discovery API and as a new optional founder-console pane (`discoveryPipeline`, zeroed when unwired).

**Default-OFF posture.** Like the growth loop, `discovery.enabled` defaults OFF and gates only the proactive
posture (reserved for the #225 outreach-prep tick); ingest/queue/PQL/emission are always live when the engine
is exercised, and a workspace that ingests no signals is byte-for-byte unchanged. No background timer is
added.

## Consequences

- The growth panel is no longer structurally unfeedable: any real signal drives event-driven funnel counts.
- #223/#225 consume `discovery/contract.ts` — a stable, additive-only seam — without depending on internals.
- The likelihood score is honest: it is a prediction, labeled UNVERIFIED, and only an external receipt
  flips a metric to verified. The onboarding/post-sales stages stay at 0 until real signals arrive (never
  fabricated).
- `config/{schema,layers,loader}.ts` gain a `discovery` block (both merge functions — or it silently drops).
- Migration `0222_customer_discovery_engine.sql` (+ `.down.sql`) is additive; verified up→down→up clean.
