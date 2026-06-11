# Spec — Portfolio Lifecycle Loop (#107)

**Premortem #8:** Every launched venture accrues liabilities (bugs, support, infra cost, security
surface) faster than revenue at first. Ten unmanaged launches = a maintenance graveyard. The Venture
Loop (#96) kills *ideas* pre-build; nothing sunsets *launched* products. This slice brings the same
kill discipline to the launched portfolio: a periodic per-venture review that scores each launched
venture on the signals the venture wave already produces — growth (#102), moat (#103), demand (#101),
revenue (#98), infra burn (#71 `tenant_usage`) — and emits one of four decisions, with **SUNSET
(kill) human-gated** through #13 and the lesson written to the #15 memory graph so it compounds.

## Goals

1. **Portfolio review as a pure decision module.** Given a venture's KPI evidence and the tenant's
   thresholds, deterministically compute a 0–100 portfolio-health score and one decision —
   `DOUBLE_DOWN` / `MAINTAIN` / `PIVOT` / `SUNSET` — with human-readable reasons. No IO, no clock of
   its own (age is passed in), so the whole thing is unit-tested in isolation (the #96/#103 pure-core
   pattern).
2. **A durable per-venture review ledger** (`portfolio_reviews`, migration `0107_`). Each review row
   snapshots the evidence it was decided on (the audit trail behind every decision) plus the SUNSET
   approval link + lifecycle status. Workspace-scoped, `venture_idea_id` FK cascade.
3. **A read API (`PortfolioService`)** the Founder Console (#104) and the portfolio dashboard route
   consume — `reviewPortfolio` (compute + persist), `listReviews`, plus the gated SUNSET lifecycle
   (`requestSunset` / `executeSunset`). Seam-injected so it unit-tests against fakes.
4. **Kill discipline is approval-gated.** A `SUNSET` decision never tears anything down on its own: it
   submits a `portfolio.sunset` request to the #13 gate (sensitive by default — an agent can never
   approve its own gate, ADR-0013). Only after a human approves does `executeSunset` write the
   post-mortem to the #15 memory graph and mark the venture idea `killed`.
5. **Founder Console surface + portfolio dashboard.** The Console gains a compact `portfolio` pane
   (decision counts + the attention reason when sunsets await approval); `GET /workspaces/:wid/portfolio`
   returns the full dashboard — every launched venture's decision, KPIs, burn, and net economics.

## Non-goals

- **No automatic teardown.** The sunset *playbook* steps the issue names beyond the post-mortem — user
  notification window, data export, refund execution, domain/infra teardown — are operational and/or
  already gated elsewhere (refunds are `billing.refund`, also #13-gated). This slice ships the
  *decision*, the *approval gate*, the *post-mortem to memory*, and the `killed` status flip; it
  surfaces the rest as recommendations, not automation. Documented in the ADR.
- **No new scheduler.** `reviewPortfolio` is a callable tick (route + service method). Wiring it to a
  cron timer is downstream (mirrors how #103 shipped the signal before #107 consumed it).
- **No mutation of the #96 decide gate.** A `PIVOT` re-enters #96 by *re-submitting a new idea* with
  the learnings (the existing `VentureService.submit` path); this slice does not change FUND/KILL.
- **No per-venture revenue attribution.** Revenue (#98) is per-workspace in the current rails; the
  review uses workspace revenue as the economic signal and documents the limitation.

## Design

### Pure core — `portfolio/decide.ts`, `portfolio/types.ts`

- `PORTFOLIO_DECISIONS = [DOUBLE_DOWN, MAINTAIN, PIVOT, SUNSET]`.
- `PortfolioEvidence` — `{ ventureIdeaId, growthScore (0–100), moatScore (0–100), moatStagnant,
  demandSignals (count), revenueCents, monthlyCostCents, ageInDays }`. The gathered KPI snapshot.
- `PortfolioThresholds` (from caps) — `doubleDownScore`, `sunsetScore`, `minReviewAgeDays`,
  `demandSignalPoints`, and `weightGrowth/weightMoat/weightDemand`.
- `portfolioHealth(evidence, thresholds)` → `0–100`: the weighted mean of growthScore, moatScore, and
  a bounded demand sub-score (`min(100, demandSignals × demandSignalPoints)`), normalized by the weight
  sum. Pure + deterministic.
- `decidePortfolio(evidence, thresholds)` → `PortfolioAssessment { ventureIdeaId, decision, score,
  netCents, hasTraction, reasons }`. The decision ladder, in priority order:
  1. **grace** — `ageInDays < minReviewAgeDays` ⇒ `MAINTAIN` (too early to judge a fresh launch).
  2. **double-down** — `score ≥ doubleDownScore` **and** `hasTraction` ⇒ `DOUBLE_DOWN`.
  3. **sunset (low health)** — `score ≤ sunsetScore` ⇒ `SUNSET`.
  4. **sunset (burning without traction)** — `monthlyCostCents > 0` **and not** `hasTraction`
     (`revenueCents = 0` and `demandSignals = 0`) ⇒ `SUNSET`. The economic kill: real cost, zero pull.
  5. **pivot** — `moatStagnant` **and not** `hasTraction` (but cheap — didn't trip the burn rule) ⇒
     `PIVOT` (re-enter #96 with learnings; salvageable at low cost).
  6. else ⇒ `MAINTAIN`.
  `hasTraction = revenueCents > 0 || demandSignals > 0`; `netCents = revenueCents − monthlyCostCents`.

### Config + caps — `portfolio/caps.ts`, `config/schema.ts` `portfolioSchema`

`portfolio` config block, all optional, **default OFF**:
- `enabled` (default `false`) — gates the proactive posture (the Console attention reason + a future
  scheduled tick). Computing/persisting a review and listing reviews are always available (read-mostly,
  harmless), mirroring how #103 keeps recording always-on while gating the Console flag.
- `doubleDownScore` (default `70`), `sunsetScore` (default `25`), `minReviewAgeDays` (default `14`),
  `demandSignalPoints` (default `20`), `weightGrowth`/`weightMoat`/`weightDemand` (default
  `0.4`/`0.35`/`0.25`).

`resolvePortfolioCaps` fills hard defaults. The block is added to `mergeSettings` **and**
`mergeLayers` (the config-layering invariant — a block missing from either is silently dropped at
runtime; the #98/#103 gotcha).

### Persistence — `db/schema/portfolio.ts`, `drizzle/0107_portfolio_lifecycle_loop.sql`

`portfolio_reviews` — workspace-scoped (`onDelete: cascade`, the #3 tenant boundary), `venture_idea_id`
FK → `venture_ideas` (`onDelete: cascade`): `id, workspace_id, venture_idea_id, decision (CHECK),
score, growth_score, moat_score, moat_stagnant, demand_signals, revenue_cents (bigint),
monthly_cost_cents (bigint), net_cents (bigint), age_in_days, reasons (jsonb), status (CHECK:
recorded/sunset_pending/sunset_executed/sunset_rejected), approval_request_id (FK → approval_requests,
SET NULL), created_by_member_id (FK → members, SET NULL), created_at`. Indexed on
`(workspace_id, venture_idea_id)`, `(workspace_id, decision)`, `(workspace_id, created_at)`.

### Approvals — `approvals/policy.ts`

`PORTFOLIO_SUNSET_ACTION = "portfolio.sunset"` added to `DEFAULT_SENSITIVE_ACTIONS`, exactly like
`autonomy.complete` / `dr.restore`: never submitted through the #13 *action route*, but evaluated
against the same workspace `approval_policies` so a sunset is human-gated by default and a workspace
can opt out with one rule.

### Service — `portfolio/service.ts`, `portfolio/default.ts`

One seam per data source (launched-venture reader, moat/growth/demand/revenue/cost readers, the review
store, the sunset gate, the memory recorder, the venture writer) + config-resolved caps; pure decide
in `decide.ts`. `default.ts` wires the real repos + the live `MoatService`/`GrowthService`/
`DemandValidationService`/`BillingManager`. **Launched = a venture evaluation with
`terminalVerdict === 'FUND'`** (`listEvaluations`); `launchedAt = evaluation.updatedAt` (when it went
terminal). The SUNSET lifecycle: `requestSunset` evaluates the #13 policy and either gates (creates a
pending request, status `sunset_pending`) or — if a workspace rule opts out — executes immediately;
`executeSunset` verifies the linked request is `approved`/`executed`, writes the post-mortem to the
#15 graph (`upsertMemory`, type `decision`, `sourceType: "event"` — within the
`memories_source_type_ck` set — dedupe `portfolio:sunset:<ideaId>`), and flips the idea to `killed`.

### Routes — `routes/portfolio.ts`

`POST /workspaces/:wid/portfolio/review` (run the tick → reviews), `GET /workspaces/:wid/portfolio`
(dashboard), `POST /workspaces/:wid/portfolio/reviews/:id/sunset` (request the gated kill → 202),
`POST /workspaces/:wid/portfolio/reviews/:id/execute` (after approval → 200). All behind
`requireIdentity` + `assertWorkspace` (the #3/#19 IDOR boundary).

### Founder Console — `founder-console/*`

Optional `portfolio` reader seam; absent ⇒ a zeroed portfolio view (works before the subsystem is
wired, like the #117/#102/#103 panes). The pane reports decision counts and adds an attention reason
when `enabled` and sunsets await approval.

## Testing

- **Unit (pure):** `portfolio-decide.test.ts` — every branch of the ladder, the health math, grace
  window, the two sunset paths, pivot vs maintain, weight normalization.
- **Unit (service):** `portfolio-service.test.ts` — in-memory fakes for every seam: review persists
  the evidence snapshot; SUNSET gated by default (pending request, no teardown); `executeSunset`
  blocked until approved, then writes the post-mortem + flips `killed`; opt-out rule auto-executes;
  not-found / wrong-decision errors.
- **Unit (console):** extend the founder-console aggregate test with a portfolio pane case.
- **Integration:** `portfolio.test.ts` — `app.inject` round-trip: signup → fund a venture → review →
  dashboard → request sunset (202, pending #13 request created) → execute blocked → approve → execute
  → idea `killed` + memory written.
