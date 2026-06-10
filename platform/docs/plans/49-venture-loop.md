# Atomic Plan: Venture Loop (#96)

Ordered, atomic steps. Each step is independently reviewable; tests come before implementation
(TDD). Spec: `docs/specs/49-venture-loop.md`.

## Phase A — Pure core (no IO, fully unit-tested)
1. **`venture/types.ts`** — `VentureIdea`, `Evidence`, `PersonaScorecard`, `Scorecard`, `GapList`,
   `IterationLogEntry`, `Verdict`, `VentureThresholds`, persisted-row shapes.
2. **`venture/rubric.ts`** — `RUBRIC_DIMENSIONS` (8 YC-bar dims from `skills/idea-refine`),
   `aggregateScorecards(advocate, reviewer, reviewerWeight)` → 0–100 (Reviewer weighted higher),
   `gapAngles(scorecard)` (weak dimensions → angle strings).
3. **`venture/decide.ts`** — `decideVenture(input)` → `{ verdict, reasoning }`. The gate.
4. **`venture/guards.ts`** — `scorecardExpired`, `hasNovelAngle`, `repeatsFailedAngle`,
   `maxIterationsReached`.
5. **`venture/admission.ts` (pure half)** — `decideVentureAdmission({enabled, hasPassingUnexpired})`.

## Phase B — Persistence
6. **`db/schema/venture.ts`** — 3 tables; add to `db/schema/index.ts` barrel.
7. **`drizzle/0074_venture.sql` + `.down.sql`** — CREATE TABLEs + indexes + CHECK enums; down drops.
8. **`db/repositories/venture.ts`** — `createIdea`, `getIdea`, `updateIdeaStatus`, `setIdeaEpic`,
   `insertScorecard`, `latestScorecard`, `hasPassingUnexpiredScorecard`, `insertIteration`,
   `listIterations`. All workspace-scoped.

## Phase C — Config
9. **`config/schema.ts`** — `ventureSchema`, add to `settingsSchema`/`ResolvedConfig`/
   `CONFIG_DEFAULTS`; `resolveVentureCaps` (hard defaults, default OFF).
10. **`config/layers.ts`** — thread `venture` through `mergeSettings`/`mergeLayers`.

## Phase D — IO orchestrator + enforcement
11. **`venture/personas.ts`** — Advocate + adversarial Reviewer system prompts (rubric-embedded).
12. **`venture/service.ts`** — `VentureService` with injected seams (`EvidenceGatherer`,
    `PersonaScorer`, repo fns, approval enqueuer, memory recorder, epic emitter, `loadConfig`,
    `now`): `submit`, `score`, `decide`, `runLoop`, `get`.
13. **`venture/admission.ts` (IO half)** — `VentureAdmission.check`, `VentureAdmissionError`,
    `ventureGatedLauncher(inner, admission)`.
14. **`venture/default.ts`** — production wiring (stub evidence, #59 persona-scorer, real repos,
    `#13` enqueuer, `#15` recorder, epic emitter via tasks repo, gated launcher).

## Phase E — Routes + app wiring
15. **`routes/venture.ts`** — submit/score/decide/get under `/workspaces/:wid/ventures`.
16. **`app.ts`** — register `ventureRoutes`; map `VentureAdmissionError` → 403; compose
    `ventureGatedLauncher` into the autonomy engine wiring.

## Phase F — Tests (written FIRST per phase, run last to green)
17. Unit: `venture-decide`, `venture-rubric`, `venture-guards`, `venture-admission`,
    `venture-service`.
18. Integration: `venture.test.ts` (submit/score/decide/get + gate blocks/off + per-ws isolation).

## Phase G — Docs + ship
19. **`docs/adrs/0049-venture-loop.md`** — the decision record.
20. **`scripts/demo/49-venture-loop.ts`** — scripted demo (video gate waived by owner).
21. `pnpm typecheck && lint && test` + integration green → commit, push, PR `feat(#96): ...`.

## Termination / decide truth table (drives the unit tests)
| score vs thresholds | iteration | novel angle? | verdict |
|---|---|---|---|
| ≥ fund | any | any | FUND |
| ≤ kill | any | any | KILL |
| [fund−band, fund) | any | any | ESCALATE |
| (kill, fund−band) | < max | yes | ITERATE |
| (kill, fund−band) | ≥ max | any | ESCALATE (max-iteration exit) |
| (kill, fund−band) | < max | no | ESCALATE (no-repeat) |
