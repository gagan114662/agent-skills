# ADR-0146: Wire the YC Startup Constitution as Enforced Code

- **Status:** Accepted (shipped in PR for #146)
- **Date:** 2026-06-11
- **Context issue:** [#146](https://github.com/gagan114662/agent-skills/issues/146)
- **Spec:** [docs/specs/146-constitution-enforcement.md](../specs/146-constitution-enforcement.md)
- **Constitution:** [docs/constitution/yc-startup-constitution.md](../constitution/yc-startup-constitution.md)
- **Builds on:** [ADR-0049](0049-venture-loop.md) (#96 pure `decideVenture` + IO `VentureService`,
  config default-OFF), [ADR-0101](0101-demand-validation-rails.md) (#101 externally-attributed
  `ExternalDemandEvidence`, de-circularised demand dimension), [ADR-0117](0117-self-healing-flywheel.md)
  (#117 `FailureEvent` → fingerprint → deduped issue), [ADR-0050](0050-founder-console.md) (#104
  pull-based read-only attention list), [ADR-0013](0013-approval-gates.md) (#13 `external.send` gate),
  [ADR-0123](0123-marketing-department-fleet.md) (#123 draft-only fleet agents).

> **Numbering note.** Spec / migration / ADR all use the `0146` slot (the issue number), per the
> project's by-issue numbering convention (ADR-0099's note) — to dodge sibling-workspace collisions
> in the shared migration sequence.

## Context

The YC Startup Constitution was prose: principles an agent might be told about in a prompt. The
owner directive: adopt it **the way Claude has a constitution** — as enforced decision criteria, not
a preamble. Three of its Articles had no enforcing code (the love-paradigm FUND gate, the pricing
ladder, the unscalable-ops templates), and there was no mechanism to *score* a venture decision
against the Articles at all, so a violation could never be detected, surfaced, or learned from.

The hard parts are not "write a check". They are: (a) defining "unaffiliated paying-intent" against a
schema with **no person-identity** on a demand signal; (b) making the gate **block** a bad FUND
without ever **silently** changing an outcome (flag-and-escalate, not auto-correct); (c) feeding
repeated violations into the existing self-healing loop without a bespoke pipeline; and (d) keeping
the whole thing **default-OFF and additive** so no existing gate weakens.

## Decisions

1. **A dedicated pure module (`src/constitution/`) holds every check; the venture service only wires
   IO.** Mirrors the #96/#117 `decide`/`engine` split — `love-gate.ts`, `pricing-ladder.ts`,
   `scorer.ts`, `articles.ts`, `caps.ts` are pure and unit-tested; `VentureService` injects a
   `ConstitutionGuard` seam and applies the results. The Articles live as **data** in `articles.ts`
   so the committed doc and the scorer cannot drift.

2. **"Unaffiliated" reuses #101's externally-attributed provenance — we do NOT add visitor identity.**
   A demand signal has no `visitorId`/`email`; its only attribution is `externalRef`. So
   "≥10 unaffiliated paying-intent signals" = **≥10 distinct `externalRef`s among
   externally-attributed signals of a paying-intent class** (`cta_click|checkout_started|waitlist|paid`).
   This is honest about the schema (every external signal is a stranger by construction) and needs no
   new column on `demand_signals` — `countUnaffiliatedPayingIntent` counts over the existing
   `listForIdea` read.

3. **B2B is a typed, optional `segment` field, not an inferred classification.** `IdeaInput` gains
   `segment?: "b2b" | "b2c"`; `venture_ideas` gains a nullable `segment` column (migration 0146).
   No segment ⇒ the love-gate never bites (default-safe). We deliberately avoid heuristic text
   classification — the gate's input is explicit and testable.

4. **The love-gate is the ONLY check that changes a verdict, and it FLAGS by escalating, never by
   silently correcting.** When a B2B FUND lacks the love evidence, the final verdict is downgraded
   FUND → **ESCALATE** — which routes the decision to a human via the existing #13 approval enqueue
   *and* records a `constitution_violations` row for the Founder Console. Every other Article check is
   flag-only: it records a violation but does not touch the verdict. This is the issue's invariant —
   "violations FLAG and escalate; they never silently auto-correct" — encoded structurally.

5. **Violations are durable rows, surfaced pull-based, and fed to the flywheel.** A
   `constitution_violations` table is the single feed: the Founder Console reads open rows into its
   attention list (the #104 pattern — read-only, no new mutation authority), and the sink hands each
   violation to `FlywheelEngine.record` under a new sixth failure class `"constitution_violation"`,
   so a *repeated* violation fingerprints, dedupes, and becomes a GitHub issue through the existing
   #117 machinery — no bespoke pipeline.

6. **Observability is egress-gated and no-op by default.** `createConstitutionObserver` logs each
   violation to Braintrust only when the #58 egress allow *and* a `BRAINTRUST_API_KEY` are present;
   otherwise it is a no-op (CI/tests/local never call out). Structured logging via the session logger
   is the always-on path.

7. **The pricing ladder is a pure proposer, never an actuator.** `proposePriceLadder` returns a
   `PricingProposal` (coarse +10% / fine +5% / hold-and-flag at ≥20% deal-loss). It has no IO and no
   path to a price change; a proposal becomes a #13 approval a human acts on. Article VIII's "raise
   prices" is thereby disciplined *and* human-gated.

8. **Default OFF, additive, no weakening.** A `constitution` config block (`enabled: false`) gates
   everything, registered at all five #58 merge sites (the known silent-drop trap). The
   `ConstitutionGuard` dep is optional on the venture service; absent or disabled ⇒ scoring is
   skipped and behaviour is byte-for-byte today's. No existing gate's thresholds or order change.

## Consequences

- **Positive:** the Constitution is now testable code with an auditable map; a FUND made on synthetic
  enthusiasm for a B2B venture is caught and escalated; repeated constitutional drift self-heals into
  issues; pricing experiments are disciplined and human-gated; manual-first acquisition is a first-class
  fleet capability.
- **Negative / trade-offs:** "unaffiliated" is a proxy (externally-attributed, not a verified distinct
  human) — a determined fake-door could still mint `externalRef`s, which is why the love-gate
  **escalates to a human** rather than auto-funding. `segment` is self-declared at intake. Both are
  acknowledged as heuristics, not physics.
- **Follow-ups:** #107 portfolio kill ladder and #114 customer-voice loop (named in the coverage map)
  deepen Articles II/III when they merge; a live-research evidence provider and #59 LLM persona scorer
  remain the #96 follow-ups.
