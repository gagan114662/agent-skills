# Spec — Growth Loop (#102)

> **Numbering note.** Spec / migration / ADR all use the `0102` slot (the issue number), per the
> project's by-issue numbering convention (see ADR-0099's note) — chosen to dodge sibling-workspace
> collisions in the shared migration sequence.

## Problem

Building is commoditized; **distribution is the bottleneck**. A FUNDed venture (#96) that deploys to a
live URL (#73) and charges real money (#98) still dies of obscurity unless its launch is *instrumented*
— who arrived, from where, did they activate, did they convert, did they come back — and unless that
signal feeds back into the decisions the platform already makes (the venture scorecard #96, the
portfolio roll-up #107, the Founder Console #104) and into the marketing fleet's (#123) next move.

Agents cannot buy trust, but they **can** industrialize everything around it: record every growth
event, score the funnel deterministically, and let the marketing agents propose channel experiments —
while every external post stays behind the #13 human gate (an agent never publishes autonomously).

## Goals

1. **Durable, per-venture growth instrumentation.** Every growth event (acquisition / activation /
   conversion / retention, tagged with a traffic source) is a workspace-scoped row that outlives the
   session that emitted it. Tenant-isolated (`workspace_id`, the #3 IDOR boundary).
2. **A pure growth-scoring module.** Deterministic funnel aggregation + a 0–100 growth score, plus the
   pure "next experiments" recommender — unit-tested in isolation, the #96 `rubric.ts` pattern. The
   score is the seam that **feeds the venture scorecard (#96)** (a 0–10 distribution signal) and the
   **portfolio loop (#107)** (a workspace-scoped per-venture read #107 can roll up).
3. **Channel experiments proposed by the marketing fleet (#123).** A marketing agent proposes a channel
   experiment (a durable row); the recommender suggests the next ones from the weakest funnel stage.
   **External posting stays #13-gated** — promoting an experiment to an external post builds the
   existing `external.send` descriptor (`buildMarketingSend`) and submits it to the #13 queue; a human
   posts. No new approval action type, no change to `approvals/policy.ts`.
4. **Growth dashboards in the Founder Console (#104).** A read-only growth pane: funnel totals, the
   growth score, top sources, experiment counts, and an attention reason when an external post awaits
   approval.

## Non-goals (deferred)

- The SEO/OG/sitemap + programmatic-landing-page *generators* and the launch-kit GIF/FAQ *content* —
  this PR builds the **instrumentation + scoring + experiment ledger + dashboards** the generators feed;
  the artifact generators are a follow-up (the seam is the contract).
- A scheduled "growth tick" timer. Growth is event-driven ingest + read; the weekly report is the
  Founder Console pane read on demand. (An opt-in tick can be added later, the #117 way.)
- Re-wiring `VentureService.score()` to consume the growth signal automatically — the pure
  `growthToVentureSignal` mapper + the per-venture read are provided and documented; hot-wiring the
  `EvidenceGatherer` is deferred (matches how #117 left its emitters as a seam).

## Design

### Data model (migration `0102_growth_loop.sql`)

Two workspace-scoped tables (mirroring #117's two-table shape):

- **`growth_events`** — the append-only instrumentation log. `(id, workspace_id→cascade, idea_id` soft
  ref to a venture idea, nullable so growth can exist before/without a #96 idea`, kind` CHECK
  ∈ acquisition/activation/conversion/retention`, source` (traffic source, default `''`)`, value` int
  ≥ 0 default 1 — the count/weight`, metadata` jsonb default `'{}'`, occurred_at, created_at)`. Indexes
  on `(workspace_id, idea_id)` and `(workspace_id, kind)`.
- **`growth_experiments`** — the channel-experiment ledger. `(id, workspace_id→cascade, idea_id` soft
  ref`, channel` text`, hypothesis` text`, target_query` text default `''` — the content engine's
  measurable target`, status` CHECK ∈ proposed/approved/running/completed/abandoned default `proposed`,
  `proposed_by_member_id` soft ref to the marketing agent`, approval_request_id` soft ref set when an
  external post is #13-gated`, result_summary` default `''`, created_at, updated_at)`. Index on
  `(workspace_id, status)`.

Session/idea/member ids are **soft references** (no FK except `workspace_id`) so an event/experiment
outlives a pruned idea or session — the #117 discipline. Additive-only ⇒ no sibling-migration collision.

### Pure core (`src/growth/`)

- **`types.ts`** — `GROWTH_EVENT_KINDS` / `EXPERIMENT_STATUSES` const tuples + `is*` guards + the row
  mirrors (`GrowthEventRecord`, `GrowthExperimentRecord`) and the derived view types.
- **`score.ts`** (the deterministic math, the `rubric.ts` analogue):
  - `funnelFromEvents(events) → GrowthFunnel` — sum `value` per kind into `{ acquisition, activation,
    conversion, retention }`.
  - `funnelRates(funnel) → { activationRate, conversionRate, retentionRate }` — each a guarded ratio in
    `[0,1]` (`x/0 = 0`): activation/acquisition, conversion/activation, retention/activation.
  - `scoreGrowth(funnel, caps) → GrowthScore` — `0` when acquisition `< minTrafficForScore`
    (not enough signal); otherwise the weighted mean of the three rates scaled to `0–100`
    (`DEFAULT_GROWTH_WEIGHTS = activation .4 / conversion .35 / retention .25`). Returns the score + the
    rates + the funnel for the dashboard.
  - `growthToVentureSignal(score) → 0–10` — the #96 scorecard distribution signal (`score/10`, clamped).
  - `recommendExperiments(funnel) → GrowthExperimentSuggestion[]` (≤3) — targets the **weakest** stage:
    low activation ⇒ onboarding/landing experiments; low conversion ⇒ pricing/CTA; low retention ⇒
    lifecycle/email. Deterministic ordering (weakest first). The "next 3 experiments" of the growth tick.
- **`caps.ts`** — `GrowthCaps { enabled, minTrafficForScore }`, `GROWTH_DEFAULTS{enabled:false}`,
  `resolveGrowthCaps(cfg)`. Default-OFF: a deployment that sets nothing records nothing automatically
  and surfaces a zeroed pane. (Event ingest via the API is always available — recording is harmless;
  `enabled` gates the proactive growth posture, mirroring how #119 keeps evidence recording always-on.)
- **`service.ts`** — the IO orchestrator over injected seams (`GrowthEventStore`,
  `GrowthExperimentStore`, `ExternalPostGate`): `recordEvent`, `summary(workspaceId, ideaId?)`,
  `proposeExperiment`, `listExperiments`, `requestExternalPost` (builds `external.send` via
  `buildMarketingSend`, submits through the gate, links `approval_request_id`, advances the experiment).
- **`default.ts`** — production wiring: the real repos + an `ExternalPostGate` backed by `createRequest`
  (status `pending` — `external.send` is sensitive-by-default, ADR-0013).

### Surfaces

- **Routes (`routes/growth.ts`)**, all `requireIdentity` + `assertWorkspace` (#19):
  - `POST /workspaces/:wid/growth/events` — record a growth event (instrumentation ingest) → 201.
  - `GET  /workspaces/:wid/growth` — the workspace growth summary (funnel + score + experiments +
    recommendations).
  - `GET  /workspaces/:wid/growth/ventures/:vid` — the per-venture growth summary.
  - `POST /workspaces/:wid/growth/experiments` — propose a channel experiment → 201.
  - `GET  /workspaces/:wid/growth/experiments` — list experiments.
  - `POST /workspaces/:wid/growth/experiments/:eid/external-post` — build + submit the #13-gated
    `external.send` for the experiment → 202 `{ approvalRequestId, status }`.
- **Config** — `growthSchema { enabled, minTrafficForScore }` registered in **all five** sites
  (`schema.ts` settingsSchema + ResolvedConfig + CONFIG_DEFAULTS; `layers.ts` mergeSettings +
  mergeLayers) — the documented config gotcha.
- **Founder Console (#104)** — `growth` read seam in `service.ts` + a `GrowthView` in `aggregate.ts`
  (funnel totals, score, top sources, proposed/running experiment counts, external-posts-awaiting count)
  + an attention reason when an external post awaits approval. Wired in `founder-console/default.ts` off
  the growth repo. Strictly read-only.

## Testing

- **Unit (`test/unit/growth-pure.test.ts`)** — `funnelFromEvents`, `funnelRates` (incl. divide-by-zero),
  `scoreGrowth` (boundaries + the `minTrafficForScore` floor), `growthToVentureSignal`,
  `recommendExperiments` (weakest-stage targeting), `resolveGrowthCaps` (default-OFF + partial override).
- **Integration (`test/integration/growth.test.ts`, real Postgres)** — sign up → fresh workspace; record
  events across kinds + sources; assert the funnel + score over the route; propose an experiment; promote
  it to an external post and assert a **pending** #13 approval is created (gated, not executed) with the
  experiment linked; assert tenant isolation (a sibling workspace sees none of it).

## Consequences

- **Default-OFF, additive.** No new mutation outside the growth tables; the console pane is optional +
  zero-valued when unwired; `approvals/policy.ts` and the executor are untouched (external posts ride the
  existing `external.send` gate). A deployment that opts into nothing is unchanged.
- **Tenant isolation.** Every query filters `workspace_id`; the integration test proves a sibling
  workspace is untouched.
- **Feeds the loops.** `growthToVentureSignal` is the #96 scorecard seam; the per-venture summary read is
  the #107 portfolio roll-up seam; the console pane is the #104 daily-review surface.
