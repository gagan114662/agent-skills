# Spec: Reload Platform — The Venture Loop: a YC-Fundability Gate for Autonomous Work (Issue #96)

> Implements [#96](https://github.com/gagan114662/agent-skills/issues/96). Phase 5 — hardening &
> governance for the 24/7 fleet. **Builds on #17** (autonomy engine: pure `decide`/`guards` + IO
> orchestrator), **#84/#25** (real agent sessions / `SessionManager` / `AutonomyLauncher`),
> **#80** (`scale/admission` chokepoint: kill-switch/budget guards as a launch gate), **#59**
> (subagent personas), **#13** (governance approvals queue), **#15** (memory graph), and **#58**
> (layered TOML config). Lifecycle: **DEFINE** artifact (`spec-driven-development`) → atomic plan →
> TDD. Out of scope: real web-research evidence collection and real LLM persona scoring are behind
> injectable seams (the production wiring exists but is exercised against fakes; a live-research
> evidence provider and a real persona-scorer over #59 are follow-ups, like #37 was for #71).

## Objective

**What:** A loop-engineered gate that ensures autonomous agents (#17/#84) only spend build budget on
**fundable** ideas, never cheap demos/MVPs. Before the platform commits a 24/7 build cycle to an
idea, the idea must clear a **YC venture bar**. The loop follows loop-engineering discipline
(act → observe → reason → repeat with explicit termination, structured feedback, budgets,
escalation):

1. **SOURCE** — idea intake as a **typed artifact** (problem, user, insight, wedge, market path).
2. **RESEARCH** — gather **evidence**; every claim carries a source or is marked an assumption.
3. **SCORE** — two **independent personas** (#59): an **Advocate** and an adversarial **Reviewer**
   score a YC-bar rubric (reuses `skills/idea-refine`): problem severity, ≥$1B market path, novel
   insight, defensibility, willingness-to-pay, 10x vs incumbents, distribution wedge, why-now. The
   two scorecards combine into one **adversarially-weighted** numeric scorecard, persisted.
4. **DECIDE** — pure thresholds (from config): **FUND** (mark funded, emit an epic task) / **ITERATE**
   (structured gap list feeds the next pass) / **KILL** (verdict + reasoning recorded to the #15
   memory graph so it is never blindly retried) / **ESCALATE** (borderline → #13 approvals, a
   human-in-the-loop exit).
5. **TERMINATION** — **max N iterations** and a **no-repeated-failed-angle** check; both exit to
   **ESCALATE** (a human decides) rather than looping forever or silently killing.

**Enforcement (the anti-demo gate):** an **admission guard** — wired exactly like the #80
kill-switch/budget guards (pure `decide` + IO controller + config flag) — that, **when enabled in
config (default OFF)**, **rejects autonomy session launches** for a workspace that lacks a passing,
unexpired venture scorecard. Gating happens at the **`AutonomyLauncher` seam** (not the generic
`SessionManager`) so the venture loop's own Advocate/Reviewer persona sessions are never blocked by
the gate they exist to satisfy (no chicken-and-egg deadlock).

**Why:** The platform can now run agents 24/7 (#17/#84/#80) but nothing stops them burning budget on
demos. The venture loop is the missing economic governor: build budget only flows to ideas that
cleared the bar, KILLs are remembered (not blindly retried), and borderline calls escalate to a
human instead of being silently decided by the machine.

**Who:** Operators of the autonomous fleet who must ensure spend serves fundable companies; a founder
(Gagan) who wants borderline ideas escalated for judgment; the autonomy engine, which consults the
gate before launching a build session.

### Acceptance criteria (from #96 — BUILD/TDD)
1. **Pure `decideVenture` yields all four verdicts from a scorecard + thresholds + loop state** —
   FUND (score ≥ fund), KILL (score ≤ kill), ESCALATE (borderline band just below fund), ITERATE
   (mid-band with a novel angle and iterations remaining). Thresholds come entirely from config.
2. **Loop terminates** — `decideVenture` returns ESCALATE (never ITERATE) when the iteration budget
   is exhausted (**max-iteration exit**) or when the only gaps left repeat an already-failed angle
   (**no-repeated-failed-angle**). Proven by unit tests.
3. **The admission guard blocks and is default-OFF** — with the venture flag enabled for a workspace
   and no passing unexpired scorecard, an autonomy launch is denied with a typed
   `no_funded_venture` error (REST 403). With the flag absent/off, the launch proceeds unchanged.
   **Per-workspace isolation**: enabling the gate in workspace A never affects workspace B.
4. **Persistence + routes** — submit/score/decide/get under `/workspaces/:wid/ventures` round-trip
   an idea through intake → scorecard → verdict, persisting the scorecard and the iteration log;
   tenant-scoped so one workspace can never read another's ventures.

### In scope
- **`venture/` module** mirroring the #17/#80 shape:
  - **`venture/decide.ts` (PURE)** — `decideVenture(input): { verdict, reasoning }` over
    `{ score, iteration, proposedAngles, failedAngles, thresholds }`. The single source of truth for
    FUND/ITERATE/KILL/ESCALATE, including both termination exits. No IO.
  - **`venture/guards.ts` (PURE)** — `maxIterationsReached`, `hasNovelAngle`/`repeatsFailedAngle`,
    `scorecardExpired(scorecard, now)` (freshness for the admission gate).
  - **`venture/rubric.ts` (PURE)** — the 8 YC-bar dimensions (from `skills/idea-refine`) +
    `aggregateScorecards(advocate, reviewer, reviewerWeight)` → a 0–100 score that weights the
    adversarial Reviewer higher (default 0.6), so the gate is conservative by construction.
  - **`venture/types.ts`** — typed artifacts: `VentureIdea`, `Evidence` (claim + `source`|assumption),
    `PersonaScorecard` (per-dimension 0–10), `Scorecard` (combined + verdict), `GapList`,
    `IterationLogEntry` (score, verdict, gaps, angles, compact working-memory summary).
  - **`venture/personas.ts`** — the Advocate and adversarial Reviewer **persona definitions** (system
    prompts embedding the rubric), used by the real persona-scorer over the #59 path.
  - **`venture/service.ts` (IO orchestrator)** — `submit` / `score` (gather evidence → dual-persona
    scoring → persist scorecard + iteration) / `decide` (run pure decide → apply side effects) /
    `runLoop` (the full act→observe→reason→repeat with termination) / `get`. All collaborators are
    injected seams: `EvidenceGatherer`, `PersonaScorer`, repos, an approval enqueuer (#13), a memory
    recorder (#15), an epic-task emitter, `loadConfig`, `now`.
  - **`venture/admission.ts`** — pure `decideVentureAdmission({ enabled, hasPassingUnexpired })` +
    `VentureAdmission.check(workspaceId)` IO (reads the config flag + scorecard repo) throwing
    `VentureAdmissionError("no_funded_venture")`; **`ventureGatedLauncher(inner, admission)`** wraps
    an `AutonomyLauncher` so only autonomy launches are gated.
  - **`venture/default.ts`** — production wiring (real evidence/persona seams, repos, the gated
    launcher composed over `autonomyLauncherFrom(sessionManager)`).
- **Persistence** — `db/schema/venture.ts` (3 tables: `venture_ideas`, `venture_scorecards`,
  `venture_iterations`, all workspace-scoped, `onDelete: cascade`) + `db/repositories/venture.ts` +
  migration **`0074_venture.sql` (+ `.down.sql`)**.
- **Routes** — `routes/venture.ts`: `POST /workspaces/:wid/ventures` (submit),
  `POST /workspaces/:wid/ventures/:vid/score`, `POST /workspaces/:wid/ventures/:vid/decide`,
  `GET /workspaces/:wid/ventures/:vid` (get). Thin adapters: `requireIdentity` + `assertWorkspace`.
- **Config** — a `ventureSchema` section in `config/schema.ts` (default OFF: `enabled?: boolean` plus
  threshold knobs + `scorecardTtlMinutes`), threaded through `layers.ts`, read per-workspace via
  `loadConfig`. `resolveVentureCaps(cfg.venture)` applies hard defaults (`enabled: false`,
  `fund: 70`, `kill: 35`, `escalateBand: 10`, `maxIterations: 3`, `reviewerWeight: 0.6`,
  `scorecardTtlMinutes: 10080` = 7 days).
- **App wiring** — register `ventureRoutes` in `app.ts`; map `VentureAdmissionError` → 403; compose
  `ventureGatedLauncher` into the autonomy engine wiring when the venture gate is configured.
- **ADR** (`docs/adrs/0049-venture-loop.md`) + **demo script** (`scripts/demos/49-venture-loop.sh`).

### Loop-engineering hardening (added to scope before merge)
- **Durable loop state (no in-memory-only loop).** A `venture_evaluations` row per idea persists the
  resume cursor — `currentIteration`, `failedAngles`, `lastScore`, accrued `costCents`, `status`
  (`active`/`terminal`) + `terminalVerdict`. A crash/restart resumes from the row; a terminal
  evaluation is never re-run. `submit` opens the evaluation; `decide` writes the cursor; `advance`
  reads it. The pure `decideVenture` gains a `budgetExhausted` input (mid-band termination, before
  max-iteration/no-repeat).
- **Dollar ceiling via the #71 tenant usage.** `advance` charges each scoring pass's
  `evaluationCostCents` to the SAME `tenant_usage` window that bounds session spend, and uses the
  SAME `budgetExceeded(spent, scale.budgetCents)` cap. An evaluation that exhausts the tenant budget
  terminates **ESCALATE**; the `POST …/ventures/:vid/advance` route answers **402** — identical
  semantics to an over-budget session launch. A `UsageMeter` seam (default no-op) keeps it injectable.
- **Infrastructure time.** A `VentureEngine` scheduled tick (opt-in `VENTURE_INTERVAL_MS`, default
  off, started in `index.ts`) advances active evaluations one step per tick; each `advance` self-gates
  on the #17 kill switch. The gate, the budget, and the tick share the seams so all stay unit-testable.
- **Added tests:** `venture-loop-durability.test.ts` (resume-after-restart via a fresh service over the
  same repo; budget-exhaust mid-loop + pre-score gate; kill-switch gating; `tick` over many evals) and
  an integration test that the advance route returns **402** against real `tenant_usage`.

### Out of scope (deferred, behind seams)
- Real web/market research in `EvidenceGatherer` (production seam returns a deterministic stub; a
  live-research provider is a follow-up). The loop, persistence, decide, and gate are fully real.
- Real LLM persona scoring over live #59 subagent sessions (`PersonaScorer` is injected; production
  wiring launches the personas but tests use a deterministic fake — same posture #71 took toward the
  e2e proof in #37).
- Per-epic scorecard linkage. v1 gates at **workspace granularity**: an enabled workspace must hold
  at least one passing unexpired scorecard before autonomy may launch there. Per-epic/per-task
  binding is a follow-up.

## Architecture — the pure core / IO orchestrator split

```
                       venture/service.ts (IO orchestrator — runLoop)
   submit ─▶ idea      │  ┌─ EvidenceGatherer.gather(idea) ──────────────┐ (seam: web/#15, stubbed)
            (artifact) │  ├─ PersonaScorer.score(idea, evidence) ────────┤ (seam: #59 Advocate+Reviewer)
                       │  │     → advocate + reviewer PersonaScorecards   │
                       │  ├─ aggregateScorecards() ─────────▶ score 0-100 │ (PURE, rubric.ts)
                       │  ├─ decideVenture({score, iteration, ───────────┐│ (PURE, decide.ts — the gate)
                       │  │     proposedAngles, failedAngles, thresholds})││
                       │  └─ apply side effects by verdict: ─────────────┘│
                       │       FUND     → markFunded + emit epic task      │
                       │       KILL     → record verdict to #15 memory     │
                       │       ESCALATE → enqueue #13 approval             │
                       │       ITERATE  → persist gap list, loop           │
                       └───────────────────────────────────────────────────┘

   Enforcement:  AutonomyEngine.launcher = ventureGatedLauncher(
                     autonomyLauncherFrom(sessionManager),     // #84 inner
                     new VentureAdmission(config, scorecardRepo))  // #80-style gate, default OFF
```

### `decideVenture` — the pure gate (single source of truth)
```ts
export type Verdict = "FUND" | "ITERATE" | "KILL" | "ESCALATE";
export interface VentureThresholds {
  fund: number; kill: number; escalateBand: number; maxIterations: number;
}
export interface VentureDecisionInput {
  score: number;             // 0–100 adversarially-weighted aggregate
  iteration: number;         // 1-based, the pass that produced `score`
  proposedAngles: string[];  // angles the NEXT iteration's gap list would pursue
  failedAngles: string[];    // angles already attempted in prior iterations
  thresholds: VentureThresholds;
}
export function decideVenture(i: VentureDecisionInput): { verdict: Verdict; reasoning: string };
```
Priority order (mirrors `scale/decide.ts`’s hard-stop-first style):
1. `score >= fund` → **FUND**.
2. `score <= kill` → **KILL**.
3. `fund - escalateBand <= score < fund` → **ESCALATE** (borderline near-miss → human judgment).
4. mid-band (`kill < score < fund - escalateBand`) → would ITERATE, but **termination first**:
   - `iteration >= maxIterations` → **ESCALATE** (iteration budget exhausted).
   - no novel angle (`proposedAngles ⊆ failedAngles`, or empty) → **ESCALATE** (can't make progress
     without repeating a failed angle).
   - else → **ITERATE**.

This makes every required test a unit test against one pure function: fund / iterate / kill /
escalate / max-iteration exit / no-repeat.

### The admission gate (default OFF, autonomy-only)
```ts
export type VentureAdmissionReason = "no_funded_venture";
export function decideVentureAdmission(s: { enabled: boolean; hasPassingUnexpired: boolean }):
  { ok: true } | { ok: false; reason: VentureAdmissionReason } {
  if (!s.enabled) return { ok: true };                 // default OFF → admit, unchanged behavior
  if (!s.hasPassingUnexpired) return { ok: false, reason: "no_funded_venture" };
  return { ok: true };
}
```
`VentureAdmission.check(workspaceId)` loads the per-workspace config (`resolveVentureCaps`), and only
if `enabled` queries `hasPassingUnexpiredScorecard(workspaceId, now)`; on deny it throws
`VentureAdmissionError`. `ventureGatedLauncher` calls `check` before delegating `launch` to the inner
`AutonomyLauncher` — so persona/subagent sessions launched directly through `SessionManager` are
never gated, only autonomy build launches are. `app.ts` maps `VentureAdmissionError` → 403.

## Data model (migration `0074_venture`)
- **`venture_ideas`** — `id, workspace_id FK cascade, problem, target_user, insight, wedge,
  market_path, status (intake|scoring|iterating|funded|killed|escalated), epic_task_id (nullable),
  created_by_member_id, created_at`. The typed intake artifact.
- **`venture_scorecards`** — `id, workspace_id FK cascade, idea_id FK cascade, iteration int,
  score int (0–100), verdict, advocate jsonb, reviewer jsonb, reasoning text, funded boolean
  default false, created_at, expires_at`. The admission gate selects `verdict='FUND' AND funded
  AND expires_at > now()`. Indexed `(workspace_id, idea_id)` and `(workspace_id, expires_at)`.
- **`venture_iterations`** — `id, workspace_id FK cascade, idea_id FK cascade, iteration int,
  score int, verdict, gap_list jsonb, angles jsonb, evidence jsonb, working_memory_summary text,
  created_at`. The iteration log + compact working memory (the loop's structured feedback).
- CHECK constraints on `status`/`verdict` enums (in the migration, the project convention — see
  `memories_source_type_ck` in 0005). `down.sql` drops all three tables.

## Config (`config/schema.ts`, default OFF)
```ts
export const ventureSchema = z.object({
  enabled: z.boolean().optional(),                 // the gate flag — default OFF
  fundThreshold: z.number().int().min(0).max(100).optional(),
  killThreshold: z.number().int().min(0).max(100).optional(),
  escalateBand: z.number().int().min(0).max(100).optional(),
  maxIterations: z.number().int().positive().optional(),
  reviewerWeight: z.number().min(0).max(1).optional(),
  scorecardTtlMinutes: z.number().int().positive().optional(),
});
```
Added to `settingsSchema` and `ResolvedConfig`/`CONFIG_DEFAULTS` (`venture: {}`), threaded through
`mergeSettings`/`mergeLayers` (replace-not-merge, so the managed layer locks the gate on).
`resolveVentureCaps` applies the hard defaults above.

## Testing (TDD — failing tests first)
**Unit (`test/unit/`, no DB):**
- `venture-decide.test.ts` — fund / iterate / kill / escalate / max-iteration-exit / no-repeat, all
  against `decideVenture`; thresholds injected.
- `venture-rubric.test.ts` — `aggregateScorecards` weights the Reviewer higher; 0–100 bounds.
- `venture-guards.test.ts` — `scorecardExpired`, novel-angle predicates.
- `venture-admission.test.ts` — `decideVentureAdmission` default-off admits; enabled + no scorecard
  denies; `ventureGatedLauncher` blocks (throws) when gated, delegates when off, and isolates per
  workspace (fake inner launcher + fake admission, no DB).
- `venture-service.test.ts` — `runLoop` over fake seams drives FUND (emits epic), KILL (records
  memory), ESCALATE (enqueues approval), ITERATE→loop→terminate.

**Integration (`test/integration/venture.test.ts`, real Postgres, isolated per-workspace):**
- submit → score → decide round-trip persists scorecard + iteration; `get` returns them.
- A FUND verdict makes `hasPassingUnexpiredScorecard` true → the gated launcher admits; a fresh
  workspace with the gate enabled and no scorecard is blocked (403); a workspace with the gate off
  admits. Per-workspace isolation asserted by creating two workspaces.

**Commands** (from `platform/`): `pnpm typecheck && pnpm lint && pnpm test` and
`pnpm --filter @reload/server test:integration` (needs `--config vitest.integration.config.ts`).

## Rollout / safety
- Default OFF for every existing workspace (config `venture` absent → `enabled: false` → the gate
  admits everything, `decideVentureAdmission` short-circuits). No behavior change until an operator
  sets `venture.enabled = true` in the managed layer.
- The gate is autonomy-only (the `AutonomyLauncher` seam), so it can never deadlock the very persona
  sessions that produce scorecards, and never blocks human/interactive launches.
- KILL verdicts are recorded to the #15 memory graph (`source_type='task'`, within the CHECK set) so
  a killed angle is surfaced to a future pass instead of being blindly retried.
```
