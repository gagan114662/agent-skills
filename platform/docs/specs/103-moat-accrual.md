# Spec — Moat Accrual (#103)

**Premortem #4:** Anything one agent fleet builds from public knowledge, every fleet can rebuild.
Durable moats — proprietary data, switching costs, distribution lock-in, accumulated evals/skills —
must be a *designed, measured* property of every venture, not a hope. This slice makes moat accrual a
first-class, scored, ledgered signal that feeds the Venture Loop scorecard (#96) and the portfolio
kill discipline (#107), and surfaces stagnant ventures in the Founder Console (#104).

## Goals

1. **Moat dimensions as a pure scoring module.** Four dimensions — `proprietaryData`, `switchingCosts`,
   `distributionLockIn`, `accumulatedEvals` — combined deterministically into a 0–100 moat score, with
   diminishing returns per dimension so a single huge accrual cannot fake a broad moat.
2. **A per-venture moat ledger.** Concrete accrual rows with provenance (what accrued, how much, in
   what unit, where it came from, who recorded it) — the audit trail behind every score.
3. **The score feeds #96 and #107.** A clean read API (`MoatService.scoreVenture`,
   `portfolioMoat`) the Venture scorecard and the portfolio tick consume; surfaced per-venture on the
   Founder Console.
4. **Stagnation flagging.** A venture with **zero** moat accrual over a configurable window is flagged
   in the Founder Console as needing attention (the pivot/kill signal #107 acts on).

## Non-goals

- No automatic telemetry collection (agents/integrations *record* accruals; this slice scores +
  ledgers + flags). Wiring specific data sources is downstream work.
- No mutation of the Venture decide gate. The moat score is an additive read surface; the FUND gate's
  thresholds are unchanged. (`enabled` default OFF keeps today's behavior.)
- #107's pivot/kill *actions* are out of scope (that issue is unbuilt). This slice provides the signal.

## Design

### Pure core — `moat/score.ts`, `moat/types.ts`

- `MOAT_DIMENSIONS = [proprietaryData, switchingCosts, distributionLockIn, accumulatedEvals]`.
- `MoatAccrual` — `{ dimension, magnitude, unit, ... }`. `magnitude ≥ 0` is the concrete size.
- `dimensionSubscore(magnitudeSum)` — a saturating (log-shaped) 0–10 curve so accruals compound with
  diminishing returns; 0 accrual → 0.
- `scoreMoat(accruals, weights)` → `MoatScore`: per-dimension subscore + weighted-mean aggregate
  scaled to 0–100. Pure + deterministic; unit-tested in isolation (the #96/#71/#117 pure-core pattern).
- `assessAccrualWindow({ entries, nowMs, windowMs })` → `{ stagnant, accrualsInWindow, lastAccrualAtMs }`.
  `stagnant` ⇔ no accrual with `createdAtMs > nowMs - windowMs`. A venture with no accruals at all is
  stagnant.

### Config + caps — `moat/caps.ts`, `config/schema.ts` `moatSchema`

`moat` config block, all optional, **default OFF**:
- `enabled` (default `false`) — gates the Founder Console stagnation flagging.
- `stagnationWindowDays` (default `30`).
- `weightProprietaryData`, `weightSwitchingCosts`, `weightDistributionLockIn`, `weightAccumulatedEvals`
  (default `1` each — equal weighting).

`resolveMoatCaps` fills hard defaults (mirrors `resolveVentureCaps`). The block is added to
`mergeSettings` **and** `mergeLayers` (the config-layering invariant — a block missing from either is
silently dropped at runtime).

### Persistence — `db/schema/moat.ts`, `drizzle/0103_moat_accrual.sql`

`moat_ledger` — workspace-scoped (`onDelete: cascade`, the #3 tenant boundary), `venture_idea_id` FK
→ `venture_ideas` (`onDelete: cascade`):
`id, workspace_id, venture_idea_id, dimension, magnitude, unit, description, provenance, source_ref,
created_by_member_id, created_at`. CHECK on `dimension` (the four) and `magnitude >= 0`. Indexes on
`(workspace_id, venture_idea_id)`, `(workspace_id, dimension)`, `(workspace_id, created_at)`.

### IO orchestrator — `moat/service.ts`, `moat/default.ts`

Seam-injected (fakes in unit tests, real repo in `default.ts`):
- `record(workspaceId, ideaId, accrual, memberId)` — persist a ledger row.
- `scoreVenture(workspaceId, ideaId)` — read accruals, apply resolved weights → `MoatScore`.
- `assessStagnation(workspaceId, ideaId, now)` — window assessment for one venture.
- `portfolioMoat(workspaceId, now)` — per-venture `{ ideaId, score, stagnant, accrualsInWindow }` —
  the surface #107 and the Founder Console consume.

### Surfaces

- Routes (`routes/moat.ts`): `POST /workspaces/:wid/ventures/:vid/moat` (record),
  `GET /workspaces/:wid/ventures/:vid/moat` (score + stagnation + accruals),
  `GET /workspaces/:wid/moat` (portfolio). Identity + `assertWorkspace` IDOR boundary.
- Founder Console (`founder-console/aggregate.ts`): optional `moat` input → `MoatView`
  (`tracked`, `flaggedStagnant`, `flagged[]`); attention reason `"N venture(s) with stagnant moat
  (no accrual in <window>)"`. Wired read-only in `founder-console/default.ts`.

### Reference doc — `docs/playbooks/moat-patterns.md`

Data flywheels, workflow embedding, marketplace liquidity, compliance depth — the patterns agents
consult at spec time to choose which moat a venture compounds.

## Test plan (TDD, failing-first)

- `moat-score.test.ts` — empty→0, saturation, weighting, 0–100 clamp; window stagnation incl. boundary.
- `moat-caps.test.ts` — defaults (OFF), overrides, layered resolution.
- `moat-service.test.ts` — record persists; scoreVenture weights; assessStagnation; portfolioMoat flags.
- `moat-founder-console.test.ts` — aggregate moat view + attention reason; absent moat ⇒ zeroed.
- `integration/moat.test.ts` — real Postgres: signup → idea → record accrual → score → portfolio →
  Founder Console surfaces the stagnant flag.

## Rollout

`enabled` default OFF; no behavior change for deployments that set no `moat` block. Migration `0103_`
is additive (one new table); `.down.sql` drops it. Numbered by issue (0103) to dodge sibling-branch
migration collisions.
