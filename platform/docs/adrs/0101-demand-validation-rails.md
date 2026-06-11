# ADR-0101: Demand Validation Rails — typed self-vs-external evidence, no circular demand

- **Status:** Accepted
- **Issue:** [#101](https://github.com/gagan114662/agent-skills/issues/101)
- **Builds on:** ADR-0049 (Venture Loop #96), ADR-0043 (Stripe revenue rails #98), ADR-0125 (pricing/checkout #125), ADR-0119 (the typed-invariant pattern #119)
- **Date:** 2026-06-11

## Context

The Venture Loop (#96) scores fundability with two LLM personas — an Advocate and an adversarial
Reviewer. Premortem #2: this is an LLM grading an LLM. For most rubric dimensions that is acceptable
judgement, but for the **demand** dimension (`willingnessToPay`) it is *circular*: no amount of model
deliberation is evidence that a real person will pay. The only cure is a stranger acting — clicking a
real checkout, leaving a deposit, joining a waitlist — captured automatically and fed back as evidence
the scorecard trusts *more* than the personas.

The danger is that "real demand evidence" silently degrades back into self-generated numbers (a model
fills in a willingness-to-pay score, a synthetic visit inflates a funnel) and the circularity returns
unnoticed. So the separation must be **structural, not a convention a reviewer enforces**.

## Decision

**1. Provenance is a typed discriminated union; demand dimensions consume a branded external-only type.**
`EvidenceProvenance` is `self_generated | externally_attributed`. The scorecard's demand input is a
branded `ExternalDemandEvidence`; its **sole constructor `externalDemandEvidence(signal)` returns `null`
for self-generated provenance**. A demand score built from self-generated evidence is unconstructable.
We prove it the #119 way: a `@ts-expect-error` compile assertion in `src` (so `pnpm typecheck` runs it)
plus a runtime `CircularEvidenceError`. *Why a brand over a runtime check alone:* a runtime check can be
forgotten at a new call site; a brand makes the wrong call site fail the build.

**2. Checkout intent composes #98/#125 — the apex signal — through the existing webhook.** Rather than a
parallel money path, the fake-door checkout is a #98 payment link carrying `metadata.kind = "demand_smoke"`
+ the experiment/venture ids. The #98 `ingestWebhook` (signature-verified, deduped, redacted) gains an
optional `DemandSignalIngestor` seam — the exact shape of the #125 `planActivator` — invoked on a payment
event. *Why reuse, not rebuild:* exactly-once, signature verification, replay protection and redaction
already exist and are tested; a stranger's money must be attributed by Stripe, never by an internal route.

**3. The funnel trusts only external provenance.** `aggregateFunnel` counts `externally_attributed`
signals only; a self-generated signal cannot move a conversion number. Funnel telemetry is persisted per
experiment so it survives restarts and feeds both the evaluation and the scorecard.

**4. The experiment bar is locked before launch (anti-p-hacking).** `evaluateExperiment` reads the
persisted spec — hypothesis, success/denominator class, pass-threshold, min-sample, window — never the
observed data. Below the minimum sample after the window closes is `INCONCLUSIVE`, not `PASS`: you cannot
declare a win on a tiny sample, and you cannot edit a launched spec's bar. *Why up-front locking:*
post-hoc threshold-fitting is the canonical way smoke tests lie.

**5. Ethics rail is mandatory at launch and instant on charge.** A pre-launch checkout (availability
`waitlist`/`preorder`) requires a non-empty disclosure to launch, and a charge that lands before the
product is `available` is auto-refunded immediately via a `Refunder` seam, recorded in `demand_refunds`.
The signal is retained (it is genuine demand evidence); the refund is the ethics action.

**6. Default-OFF, additive, no new egress.** New migration `0101_`, a new `demand/` module, additive
seams on BillingManager and VentureService (both optional — undefined in every existing test), and demand
routes. The smoke test's only outbound call is the #98 checkout mint, behind the existing billing opt-in +
data-privacy egress gate. With no experiments, the venture scoring path is unchanged.

## Consequences

- The scorecard's demand dimension can never again be filled by a model — the type system refuses it, and
  CI's typecheck is the enforcement, not a human reviewer.
- A single composition point (the #98 webhook) means every demand `paid` signal inherits signature
  verification, dedupe, and redaction for free.
- Trade-off: demand evidence requires a deployed fake-door and real traffic, so an idea with no smoke test
  simply has no external demand evidence and falls back to the (clearly-labelled) synthetic persona score —
  honest about the gap rather than fabricating confidence.
- A follow-up may surface the funnel + experiment verdicts in the #104 Founder Console; this PR keeps the
  read surface to the demand routes to bound scope.
