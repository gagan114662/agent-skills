# Spec: Wire the YC Startup Constitution as Enforced Code (Issue #146)

> Implements [#146](https://github.com/gagan114662/agent-skills/issues/146). **Builds on #96**
> (the Venture Loop: pure `decideVenture` + IO `VentureService` + config default-OFF), **#101**
> (demand validation rails: externally-attributed `ExternalDemandEvidence`, the de-circularised
> demand dimension), **#117** (self-healing flywheel: `FailureEvent` → fingerprint → deduped
> issue), **#104** (Founder Console: pull-based read-only attention list), **#13** (governance
> approvals), **#123** (marketing department fleet + the `external.send` gate), **#119**
> (evidence-priced autonomy), and **#58** (layered TOML config). Lifecycle: DEFINE artifact →
> atomic plan → TDD.
>
> **Numbering note.** Spec / migration / ADR all use the `0146` slot (the issue number), per the
> project's by-issue numbering convention (see ADR-0099's note) — to dodge sibling-workspace
> collisions in the shared migration sequence.

## Objective

**What:** Adopt the [YC Startup Constitution](../constitution/yc-startup-constitution.md) as
**enforced decision criteria**, the way Claude has a constitution — not a prompt preamble. Three
things:

1. **Commit the constitution** with an auditable Article → enforcing-system → file-paths coverage
   map (done: `docs/constitution/yc-startup-constitution.md`).
2. **Close three unenforced gaps** as code:
   - **Article I (love paradigm):** a B2B venture cannot pass FUND without ≥10 unaffiliated
     paying-intent signals.
   - **Article VIII (pricing ladder):** a pure 10/5/20 pricing-experiment module that proposes
     price increments and flags when deal-loss exceeds 20% — proposals only, approval-gated.
   - **Article IV (unscalable ops):** fleet task templates for manual-first, founder-led user
     acquisition (Collison-install outreach drafts) — all external sends stay approval-gated.
3. **Score every SOURCE / FUND / KILL decision** against the Articles with a pure, deterministic
   module; record violations as structured events, surface them on the Founder Console attention
   list, and log them to observability so the flywheel turns repeated violations into issues.

**Invariant:** violations **FLAG and escalate to the owner — they never silently auto-correct.**
These are heuristics, not physics. The one place a verdict changes (Article I love-gate) downgrades
FUND → **ESCALATE** (routes the decision to a human via #13); it does not silently fund or kill.

**Default OFF.** The whole apparatus is gated by a new `constitution` config block
(`enabled: false`). A deployment that sets nothing keeps today's behaviour byte-for-byte.

## Non-goals

- No new ML/LLM classification of "is this B2B" — we add a typed, optional `segment` field on the
  intake idea (`b2b` | `b2c`), defaulted null. No segment ⇒ the B2B gate never bites.
- No per-person identity on demand signals. "Unaffiliated" reuses #101's existing definition:
  **externally-attributed** evidence (`isExternallyAttributed`), deduped by `externalRef`. We do
  not add visitor-identity tracking.
- No autonomous price changes ever. The pricing ladder is a pure proposer; the approval is a #13
  request a human acts on.
- We do not weaken any existing gate. Constitution checks are additive and skip entirely when the
  block is OFF or the dep is absent.

## Design

### Pure modules (`src/constitution/`, no IO — unit-tested)

- **`articles.ts`** — the eight Articles as data (`id`, `title`, `principle`, `source`,
  `enforcedBy`). The single source of truth the doc and the scorer share.
- **`caps.ts`** — `ConstitutionCaps` + `resolveConstitutionCaps(cfg)` (hard defaults; `enabled`
  default false). Knobs: `loveMinSignals` (10), pricing `coarseStepPct` (10), `fineStepPct` (5),
  `dealLossCeilingPct` (20), `payingIntentClasses`.
- **`love-gate.ts`** — `evaluateLoveGate(input)` → `{ gated, violation }`. Bites only when
  `enabled && verdict === "FUND" && segment === "b2b" && unaffiliatedPayingIntentSignals < min`.
  `gated` instructs the caller to downgrade FUND → ESCALATE.
- **`pricing-ladder.ts`** — `proposePriceLadder({ currentPriceCents, dealLossPct, caps })` →
  `PricingProposal`. The 10/5/20 rule: while deal-loss is comfortably low, propose a **+10%**
  coarse step; as deal-loss approaches the ceiling, propose a **+5%** fine step; at/above **20%**
  deal-loss, propose **hold** and **flag** (the ceiling is found). Always a proposal.
- **`scorer.ts`** — `scoreDecision(ctx, caps)` → `{ violations }`. Deterministic checks per stage:
  - Article I (FUND, B2B, < min signals) → `love_paradigm_unmet` (block-class; mirrors the gate).
  - Article V (FUND with no externally-attributed demand evidence) → `funded_on_synthetic_demand`.
  - Article VIII (FUND with no realized `paid` signal) → `funded_without_realized_payment`.
  - SOURCE (B2B sourced with zero demand evidence) → `b2b_sourced_without_demand` (info — early
    warning that love evidence will be required at FUND).
  - KILL is constitution-compliant (Article II honoured) → no violation.

### Demand helper (pure, in `src/demand/signals.ts`)

`countUnaffiliatedPayingIntent(signals, classes)` — counts **distinct `externalRef`s** among
**externally-attributed** signals whose class is a paying-intent class. Reuses the existing
`SignalStore.listForIdea` read; no new DB query, no schema change to `demand_signals`.

### Persistence (migration `0146`)

- `ALTER TABLE venture_ideas ADD COLUMN segment text` — nullable, `CHECK (segment IN ('b2b','b2c'))`
  or NULL. Additive; existing rows and the existing route stay valid (segment optional).
- `CREATE TABLE constitution_violations` — workspace-scoped durable feed: `article`, `code`,
  `severity` (`block|high|medium|low`), `stage` (`SOURCE|FUND|KILL`), `verdict`, `message`,
  `status` (`open|acknowledged`), `idea_id` (FK → `venture_ideas` `ON DELETE CASCADE`). Read by the
  Founder Console; written by the venture service's constitution sink.
- Flywheel: add a sixth `FailureClass` `"constitution_violation"` (`types.ts` + `db/schema/flywheel.ts`).

### Venture-loop integration (`src/venture/service.ts`)

A new optional `constitution?: ConstitutionGuard` dep on `VentureServiceDeps` (default absent ⇒ no
behaviour change). The guard bundles: `enabled(wid)`, `caps(wid)`, `evidenceFor(wid, ideaId)` (the
demand reads behind one seam: distinct unaffiliated paying-intent count, external-demand-present,
paid-present), and `record({ stage, verdict, violations })` (persist + flywheel + observe).

- **`submit` (SOURCE):** when enabled, score the SOURCE stage and record any violations. No verdict.
- **`decide` (FUND/KILL):** after the pure `decideVenture` produces the base verdict, when enabled:
  1. Run the love-gate; if `gated`, set the final verdict to **ESCALATE** and append the reason.
  2. Run `scoreDecision` for the (final) stage, collect violations (love violation included).
  3. `record(...)` all violations. The existing ESCALATE side-effect (enqueue #13 approval) and the
     attention-list surfacing give the owner the flag + the escalation.

### Founder Console (`src/founder-console/`)

A new optional `ConstitutionReader { openViolations(wid) }` seam → snapshot → a pushed
`attention.reasons` entry (`"N constitution violation(s) flagged"`). Pull-based, read-only — the
canonical #104 pattern.

### Observability (`src/observability/constitution-log.ts`)

`createConstitutionObserver()` → `{ log(violation, ctx) }`, gated by the #58 egress allow + a
Braintrust API key, no-op otherwise (so CI/tests/local never call out). The sink calls it per
violation; structured logging is the always-on path.

### Article IV templates (`src/marketing/blueprint.ts`)

`UNSCALABLE_OPS_TEMPLATES` — manual-first, founder-led acquisition briefs (Collison install:
personally onboard the first users one by one). They carry only `DRAFT_TOOLS`; any external send
routes through the existing `buildMarketingSend` → #13 `external.send` gate (approval-gated by
construction).

## Tests

- **Unit:** love-gate (bites only for B2B FUND under threshold; never for B2C, ITERATE, KILL,
  disabled), pricing-ladder (the 10/5/20 bands + flag at ceiling, never a price change), scorer
  (each violation code + clean pass), `countUnaffiliatedPayingIntent` (externally-attributed +
  paying-intent + distinct-externalRef), the constitution sink (persists + flywheel.record),
  Founder Console attention reason, Article IV templates (exist; carry no send tool).
- **Integration:** a FUND-worthy B2B idea with **no** demand evidence → `decide` returns ESCALATE,
  a `constitution_violations` row exists (`love_paradigm_unmet`), the idea is `escalated`, and a #13
  approval was enqueued. Proves the gate blocks **and** flags, and that existing gates are intact
  (a B2C idea, or a B2B idea with ≥10 signals, still FUNDs).

## Acceptance criteria → where satisfied

1. Constitution committed + coverage map → `docs/constitution/yc-startup-constitution.md`.
2a. Article I FUND gate → `constitution/love-gate.ts` + `venture/service.ts`.
2b. Article VIII pricing ladder → `constitution/pricing-ladder.ts`.
2c. Article IV templates → `marketing/blueprint.ts`.
3. Scorer on SOURCE/FUND/KILL + structured events + flywheel + Braintrust → `constitution/scorer.ts`,
   `db/repositories/constitution.ts`, `flywheel` class, `observability/constitution-log.ts`.
4. FLAG + escalate via Founder Console, never auto-correct → `founder-console/aggregate.ts`,
   ESCALATE downgrade (human-routed), no silent mutation.
5. Tests (unit per gate + scorer; integration FUND-without-evidence blocked+flagged); migration
   `0146`; no weakening of existing gates.
