# Spec: Reload Platform — Demand Validation Rails: real strangers, real checkout intent, no circular evidence (Issue #101)

> Implements [#101](https://github.com/gagan114662/agent-skills/issues/101). **Builds on #96/ADR-0049**
> (the Venture Loop — the dual-persona scorecard `aggregateScorecards` + the eight YC-bar
> `RUBRIC_DIMENSIONS`, of which `willingnessToPay` is the demand dimension), **#98/ADR-0043** (the
> inbound-only Stripe revenue rails: signature-verified, deduped `ingestWebhook` that already round-trips
> payment-link `metadata` and records `willingness_to_pay` evidence), and **#125/ADR-0125** (workspace-
> scoped checkout minting). Lifecycle: DEFINE artifact → atomic plan → TDD failing-first → ADR → one PR.
> **Video gate waived by the owner.**

## Objective

**What:** Premortem #2 of the Venture Loop — *Advocate-vs-Reviewer is an LLM grading an LLM. The
scorecard's demand dimension is circular until a real stranger acts.* This makes real-world demand a
first-class, automated, **structurally non-circular** pipeline: a fake-door smoke test per venture
hypothesis, funnel telemetry baked in, and — the core mechanism — a **typed separation between
self-generated and externally-attributed evidence** so the scorecard's demand dimension can consume
*only* evidence that came from outside the building. Circular evidence is not rejected by convention or
review; it is **unconstructable in the type system**, and a test proves it.

The five surfaces:

1. **Typed provenance separation (the architectural core).** `EvidenceProvenance` is a discriminated
   union: `self_generated` (an internal heuristic or an LLM persona score — circular) vs
   `externally_attributed` (a real outside actor, carrying an `externalRef` attribution — a Stripe event
   id, an anonymized visitor token). The demand dimension consumes a branded `ExternalDemandEvidence`
   whose **sole constructor returns `null` for self-generated provenance**. A demand score backed by
   self-generated evidence is therefore *unconstructable*; a `@ts-expect-error` compile proof (which
   `pnpm typecheck` runs over `src`) plus a runtime `CircularEvidenceError` assertion guard the boundary
   — exactly the #119 invariant-class pattern.

2. **Checkout-intent capture composing #98/#125 (the strongest signal class).** A real charge / deposit
   is the apex demand signal. The fake-door checkout reuses the #98 payment link minted with
   `metadata.kind = "demand_smoke"` + the experiment/venture ids, and the #98 deduped, signature-verified
   `ingestWebhook` calls a new best-effort `DemandSignalIngestor` seam (mirrors the #125 `planActivator`)
   on a payment event — turning a stranger's checkout into an externally-attributed `paid` signal,
   exactly-once.

3. **Funnel telemetry per venture.** The funnel `visit → cta_click → checkout_started → paid` (plus the
   `waitlist` branch) is persisted per experiment. Pure `aggregateFunnel` counts each stage and the
   stage-to-stage conversion rates. Only externally-attributed signals count — a self-generated "visit"
   cannot inflate the funnel (the store records provenance, the aggregate trusts only `externally_attributed`).

4. **Experiment registry (anti-p-hacking).** Every smoke test registers a locked `ExperimentSpec`
   *before launch*: a hypothesis, a success class + denominator class, a pass-threshold conversion rate, a
   minimum sample, and a sample window `[start, end)`. Pure `evaluateExperiment` reads the **locked** spec,
   never the observed data: below the minimum sample after the window closes → `INCONCLUSIVE` (you cannot
   declare a win on three visitors), threshold met with enough sample → `PASS`, otherwise `FAIL`. Editing a
   launched spec's bar is refused — the goalposts cannot move after data arrives.

5. **Ethics rail.** A pre-launch checkout (availability `waitlist` / `preorder`) must carry a non-empty
   `disclosure` at launch (a launch without it is refused), and a real charge that arrives before the
   product is `available` is **auto-refunded instantly** via a `Refunder` seam, with the refund recorded.
   The signal still counts as demand evidence (they tried to pay) — the refund is an ethics action, not an
   erasure.

## Non-circular evidence, structurally

```
EvidenceProvenance
 ├─ { kind: "self_generated";       generator: string }          ← LLM persona / heuristic (circular)
 └─ { kind: "externally_attributed"; attribution: ExternalAttribution }
                                       attribution.externalRef: non-empty id from outside the building

externalDemandEvidence(signal): ExternalDemandEvidence | null     ← sole constructor; null for self_generated
demandScoreFromExternal(ExternalDemandEvidence[]): number (0–10)  ← only the branded type is accepted
overlayDemandDimension(advocate, reviewer, weight, demandScore?)  ← REPLACES synthetic willingnessToPay
```

The venture `score()` path gains an optional `DemandEvidenceSource` seam returning
`ExternalDemandEvidence[]`. When external evidence exists for an idea, the aggregate is recomputed with the
real demand score overlaid onto `willingnessToPay`, *replacing* the synthetic persona number. With no
external evidence the path is byte-for-byte unchanged (default-OFF, like every prior phase).

## Funnel + experiment evaluation (pure)

- `DEMAND_SIGNAL_CLASSES = [visit, cta_click, checkout_started, waitlist, paid]`, strength-ordered.
- `aggregateFunnel(signals)` → `{ counts, conversion }` over `externally_attributed` signals only.
- `evaluateExperiment(spec, funnel, nowMs)`:
  - window open & sample `< minSample` → `PENDING`
  - window closed & sample `< minSample` → `INCONCLUSIVE` (anti-p-hacking)
  - `conversion(successClass / denominatorClass) ≥ passThreshold` & sample `≥ minSample` → `PASS`
  - else → `FAIL`

## Persistence (migration `0101_demand_validation_rails`)

Three additive, workspace-scoped tables, independent of every other branch's schema:

- `demand_experiments` — the locked spec + lifecycle (`registered → live → concluded`), `venture_idea_id`
  (FK → `venture_ideas`, SET NULL), `availability`, `disclosure`, `landing_url`, `checkout_url`. The bar
  columns (`pass_threshold`, `min_sample`, `success_class`, `denominator_class`, `window_*`) are written at
  register and never updated by the service.
- `demand_signals` — one externally-attributed funnel event: `signal_class`, `external_ref` (NOT NULL — the
  attribution), `amount_cents`. Deduped `unique(workspace_id, experiment_id, external_ref)` so a replayed
  webhook never double-counts.
- `demand_refunds` — the ethics auto-refund audit (one row per pre-availability charge refunded).

`number-by-issue` (0101) per `drizzle/README.md` to dodge sibling-branch migration-number collisions.

## API (thin adapters; logic in `DemandValidationService`)

- `POST /workspaces/:wid/ventures/:vid/experiments` — register a locked spec (400 on a missing bar/window).
- `POST .../experiments/:eid/launch` — deploy the fake-door + mint checkout (409 if pre-launch with no
  disclosure; 409 if already live).
- `POST .../experiments/:eid/signals` — capture a funnel signal (`visit`/`cta_click`/`checkout_started`/
  `waitlist`); the public landing page posts these.
- `GET .../experiments/:eid` — the spec + funnel + evaluation.

The apex `paid` signal arrives only through the #98 signature-verified webhook composition, never a public
route — a stranger's money is attributed by Stripe, not by us.

## Testing strategy (TDD, failing-first)

**Unit (`test/unit`, no DB/network):** provenance (the branded constructor returns `null` for
self-generated + the `@ts-expect-error` compile proof + the runtime `CircularEvidenceError`); funnel
aggregation trusts only external provenance; `evaluateExperiment` PENDING/INCONCLUSIVE/PASS/FAIL incl. the
anti-p-hacking small-sample case; the demand overlay replaces `willingnessToPay`; the service over fakes
(register → launch ethics gate → record → checkout ingest auto-refund → evaluate).

**Integration (`test/integration`, real Postgres + Fastify):** register a locked experiment, launch,
capture funnel signals, drive a signed `demand_smoke` checkout webhook → a deduped `paid` signal →
evaluate `PASS`, and confirm the venture scorecard's aggregate moves only when external evidence is
present. A circular-evidence path is rejected; a pre-availability charge is auto-refunded.

## Boundaries

- **Always:** demand dimensions consume the branded `ExternalDemandEvidence` only; the funnel trusts only
  `externally_attributed` provenance; the experiment bar is locked before launch.
- **Never:** a self-generated score reaching a demand dimension (unconstructable); a checkout webhook
  double-counting (deduped); a pre-availability charge kept without a recorded refund; a new config/runtime
  egress (the smoke test reuses the #98 opt-in + data-privacy gate).
