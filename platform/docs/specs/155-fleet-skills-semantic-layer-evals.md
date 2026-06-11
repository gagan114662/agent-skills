# Spec — Issue #155: Skills + semantic layer + eval-gated maintenance for the fleet

## Thesis (Anthropic self-service analytics playbook)
Accuracy is a *context + verification* problem: 21% → 95%+ with skills; skills **drift** (95% → 65% in a
month) without maintenance-as-code; agents must be **structurally routed** to governed definitions before
raw data. This PR encodes all three as code + tests + CI gates.

## Scope (one coherent PR)
1. **Per-agent skills in repo** — `platform/agents/skills/<agent>/{knowledge,runbook}.md` for all 7 fleet
   agents (scout, echo, quill, postmark, bid, lens, mark) + a versioned `manifest.json` catalog. Knowledge
   skill = thin router to curated reference files (loaded on demand). Runbook skill = the senior-practitioner
   procedure (clarify → consult governed sources first → execute → self-review).
2. **Semantic layer** (`apps/server/src/semantic/`) — pure `METRIC_CATALOG` of canonical metric functions
   over the governed scorers (growth 0102, demand 0101, venture 0096, moat 0103, usage). Lens answers metric
   questions ONLY through these (one number, same number everywhere). Raw-data exploration is the documented
   fallback, **flagged** in the answer.
3. **Provenance + freshness** (`semantic/provenance.ts` + `answer.ts`) — every answer cites its path
   (`semantic_layer › curated_reference › raw_data`) and freshness, rendered in brand voice.
4. **Eval-gated maintenance** (`apps/server/src/evals/`) — offline eval suite per agent domain
   (`platform/agents/evals/<agent>.json`); pure graders + regression delta; a `EvalService` persists
   `eval_runs` rows (skill version, git SHA, model id, pass/fail, tokens), logs to Braintrust via the
   existing tracer seam, and feeds regressions to the #117 flywheel (`failureClass: "eval_regression"`).
   CI runs the suites and surfaces a before/after delta vs a committed baseline.
5. **Colocation CI** — `scripts/check-skill-colocation.mjs` (quality job) fails a PR that changes a metric
   surface (governed `score.ts`/`signals.ts`/`rubric.ts` or a migration touching a governed table) without a
   paired change under `platform/agents/skills|evals/`.

## Architecture — pure modules + IO seams (house pattern)

### `apps/server/src/semantic/`
- `catalog.ts` (pure) — `MetricDefinition {id,label,unit,source,owner,description}`; `METRIC_CATALOG`,
  `getMetric`, `listMetrics(source?)`, `isMetricId`. IDs are stable + dotted: `growth.score`,
  `growth.venture_signal`, `demand.visit_to_paid`, `venture.score`, `moat.score`, `usage.cost_cents`.
- `provenance.ts` (pure) — `AnswerPath = semantic_layer|curated_reference|raw_data`; `PATH_RANK`;
  `Freshness {asOfMs,ageMs,stale}`; `computeFreshness(asOfMs,nowMs,maxAgeMs)`.
- `answer.ts` (pure) — `MetricAnswer`; `buildAnswer(def, resolved, nowMs, caps)`; `renderValue(v,unit)`;
  `formatAnswer(answer)` → brand voice string with provenance + freshness + fallback flag.
- `types.ts`, `caps.ts` (`resolveFleetCaps` reads the shared `fleet` config block, default OFF),
  `service.ts` (`SemanticLayerService.answer(workspaceId, metricId)` via a `MetricResolver` seam over the
  governed services; falls back to `raw_data` flagged when no governed value), `default.ts`,
  `routes/semantic.ts` (`GET /workspaces/:wid/semantic/metrics`, `GET …/semantic/metrics/:id`).

### `apps/server/src/evals/`
- `types.ts` — `EvalCase`, `EvalSuite`, `Grader`, `EvalCaseResult`, `EvalRunSummary`, `EvalRunRecord`.
- `grade.ts` (pure) — graders `exact|contains|numeric|regex|provenance`; `gradeCase(case, actual)`.
- `regression.ts` (pure) — `summarizeRun(results)`; `compareRuns(baseline, current)` → delta + `regressed`.
- `corpus.ts` (pure) — `parseSuite(json)`; `answerCase` deterministic answerer (semantic-layer cases route
  through the real semantic catalog; skill-discipline cases check skill-file invariants). Offline + model-free.
- `service.ts` — `EvalService.runSuite(workspaceId, suite, ctx)`: grade → persist `eval_runs` → trace
  (Braintrust seam) → on regression, `regressionSink.record(eval_regression failure)`. Seams: `EvalRunStore`,
  `EvalTracer`, `RegressionSink`, `caps`.
- `caps.ts`, `default.ts`, `db/repositories/evals.ts`, migration `0155_fleet_evals.sql` (`eval_runs`).

### Wiring
- `marketing/blueprint.ts` — add `skills: string[]` to `MarketingAgentSpec`; each agent carries its 2 skills.
- `subagents/scope.ts` — `personaHarnessEnv` emits `AGENT_SKILLS` (comma-joined names) so the runtime knows
  which skills to load for the session (the load contract is env, never argv — same as prompt/tools/model).
- `runtime/harness.ts` — `AGENT_SKILLS` rides the existing env passthrough (documented; no fabricated CLI flag).
- `flywheel/types.ts` — add `eval_regression` to `FAILURE_CLASSES`.
- `moat` tie-in — `evalAccrualMagnitude(summary)` pure helper maps an eval suite pass into an
  `accumulatedEvals` moat accrual (the compounding-moat loop). Light seam, documented.
- config — ONE `fleet` block (7 schema/layers sites), read by both semantic + evals caps. Default OFF.

### CI
- `scripts/check-skill-colocation.mjs` — quality-job step; diff-based; dependency-free (precedent
  `check-demo-refs.mjs`).
- `scripts/run-evals.ts` (tsx) — runs all suites, writes `eval-report.json` + a markdown delta vs
  `platform/agents/evals/baseline.json`; non-zero exit on regression below tolerance. New `evals` CI job
  (`needs: quality`).
- `test/unit/evals-corpus.test.ts` gates regression inside the normal unit run too.

## Non-goals / deferred
- No real model calls in evals (offline, deterministic — CI-safe, no spend). The answerer is the real
  semantic layer for metric questions + pure skill-invariant checks for discipline questions.
- No new RBAC — reads ride `assertWorkspace` (#19) tenant boundary.
- Catalog #152 / constitution #146 not on this branch — `evals` rails are written so #146's scorer can
  reuse `grade.ts`/`regression.ts` (documented seam); expect a light rebase when they land.

## TDD order
grade/regression pure → catalog/provenance/answer pure → corpus + suites → semantic service+route →
eval service + repo → skills wiring → flywheel class → config → CI scripts → integration tests.
