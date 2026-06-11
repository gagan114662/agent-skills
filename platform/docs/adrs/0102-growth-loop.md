# ADR-0102: Growth Loop — distribution instrumentation so launches don't die of obscurity

- **Status:** Accepted (shipped in PR for #102)
- **Date:** 2026-06-11
- **Context issue:** [#102](https://github.com/gagan114662/agent-skills/issues/102)
- **Spec:** [docs/specs/102-growth-loop.md](../specs/102-growth-loop.md)
- **Builds on:** [ADR-0049](0049-venture-loop.md) (#96 — the pure `rubric.ts` 0–100 scorer + the
  scorecard seam this growth signal feeds), [ADR-0050](0050-founder-console.md) (#104 — the read-only
  daily-review pane the growth view is added to), [ADR-0123](0123-marketing-department-fleet.md) (#123 —
  the marketing fleet that proposes channel experiments), [ADR-0013](0013-approval-gates.md) (the
  `external.send` gate every external post rides), [ADR-0117](0117-self-healing-flywheel.md) (the
  two-table workspace-scoped durable shape + the config-block gotcha), [ADR-0035](0035-config-layering.md)
  (#58 — the layered config the `growth` block plugs into), [ADR-0099](0099-disaster-recovery.md) (the
  by-issue numbering convention).

> **Numbering note.** Spec/migration/ADR all use the `0102` slot (the issue number), per the project's
> by-issue numbering convention (see ADR-0099's note) — chosen to dodge sibling-workspace collisions in
> the shared migration sequence.

## Context

Premortem #1: building is commoditized; **distribution is the bottleneck.** A FUNDed venture (#96) that
deploys to a live URL (#73) and charges real money (#98) can still die of obscurity. Agents cannot buy
trust, but they CAN industrialize everything around it — *if* the launch is instrumented. Today a
launch's growth signal (who arrived, from where, did they activate / convert / come back) evaporates,
so nothing feeds back into the venture scorecard, the portfolio loop, or the marketing fleet's next
move.

The hard part is not "store an analytics event" — it is making growth signal a **first-class, pure,
tenant-scoped input** to the decisions the platform already makes, while keeping the one irreducible
human gate: an agent never publishes to an external platform autonomously.

## Decisions

1. **Mirror the #117/#96 shape: two workspace-scoped durable tables + a pure scoring core.**
   `growth_events` is the append-only instrumentation log (one row per acquisition / activation /
   conversion / retention event, tagged with a traffic source); `growth_experiments` is the
   channel-experiment ledger. Every query filters `workspace_id` (the #3 IDOR boundary); `idea_id` /
   `proposed_by_member_id` / `approval_request_id` are **soft references** so a growth record outlives a
   pruned idea/member/approval. Additive-only ⇒ no sibling-migration collision.

2. **The scorer is pure and deterministic (the `rubric.ts` analogue).** `growth/score.ts` turns the raw
   events into the funnel (`funnelFromEvents`), the guarded stage rates (`funnelRates`, `x/0 = 0`), the
   0–100 score (`scoreGrowth`, the weighted mean of the three rates — activation .4 / conversion .35 /
   retention .25 — forced to 0 below a `minTrafficForScore` floor so a high rate off a handful of
   visitors is not mistaken for signal), the #96 distribution signal (`growthToVentureSignal`, 0–100 →
   0–10), and the weakest-stage-first "next 3" experiments (`recommendExperiments`). Unit-tested in
   isolation; the IO `service.ts` only reads/persists.

3. **Feeds the loops via reads + a pure mapper, not a rewrite.** The growth score reaches the **#96
   scorecard** as a 0–10 distribution signal (`growthToVentureSignal` — the documented seam) and the
   **#107 portfolio loop** as a workspace-scoped per-venture summary read (`GET .../growth/ventures/:vid`,
   the same shape #104 consumes). #107 has no code yet, so the read IS the seam it will roll up. Hot-wiring
   `VentureService.score()`'s `EvidenceGatherer` to pull the signal automatically is deferred (the #117
   "seam is the contract" posture) — kept out so the venture gate's behaviour is unchanged by default.

4. **Channel experiments are agent-proposed; external posting stays #13-gated.** A marketing agent (#123)
   proposes an experiment (a durable row). Promoting it to an external post builds the **existing**
   `external.send` descriptor (`buildMarketingSend`) and submits it as a **pending** #13 approval — a
   human approves and posts. No new approval action type, no change to `approvals/policy.ts` or the
   executor. The gated request is linked back onto the experiment (`approval_request_id`); the post is
   never auto-executed (asserted by the integration test).

5. **Surfaced read-only in #104.** The Founder Console gains a `growth` view (funnel stage counts, the
   0–100 score, top acquisition source, the experiment pipeline counts, and how many external posts are
   submitted-for-approval). The reader computes the score off the **same** pure scorer the routes use, so
   the console and the API never disagree. No new mutation, no new route — strictly read-only.

6. **Default-OFF policy, always-on ingest.** A `growth` config block (`enabled`, `minTrafficForScore`)
   joins the #58 layered config — registered in **both** `mergeSettings` and `mergeLayers` (and the
   `schema.ts` settingsSchema / ResolvedConfig / CONFIG_DEFAULTS), the documented gotcha that a block
   missing from any of them silently drops at runtime. `enabled` defaults false and gates only the
   proactive posture; event ingest + scoring reads are always available (recording a tenant-scoped event
   is harmless — the #119 "evidence recording is always-on" posture).

## Consequences

- **Additive + default-OFF.** New tables, new routes, a new optional console field, a new config block —
  a deployment that opts into nothing is unchanged. No background tick (growth is event-driven ingest +
  on-demand read; a scheduled weekly-report tick can be added later the #117 way).
- **Tenant isolation.** Every query filters `workspace_id`; the integration test proves a sibling
  workspace sees a zeroed funnel and none of the first's events.
- **Deferred:** the SEO/OG/sitemap + programmatic-landing-page generators and the launch-kit GIF/FAQ
  content (this PR is the instrumentation + scoring + experiment ledger + dashboards they feed); the
  scheduled growth-tick timer; auto-wiring the #96 `EvidenceGatherer` to the growth signal.
