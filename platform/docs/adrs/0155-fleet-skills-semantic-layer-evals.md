# ADR-0155: Per-agent skills, a semantic layer for governed metrics, and eval-gated skill maintenance

- **Status:** Accepted (shipped in PR for #155)
- **Date:** 2026-06-11
- **Context issue:** [#155](https://github.com/gagan114662/agent-skills/issues/155)
- **Spec:** [docs/specs/155-fleet-skills-semantic-layer-evals.md](../specs/155-fleet-skills-semantic-layer-evals.md)
- **Builds on:** [ADR-0123](0123-marketing-department-fleet.md) (the named fleet — scout/echo/quill/postmark/
  bid/lens/mark — whose specs gain a `skills` kit), #68 (the cloud runtime that loads per-session config as
  env, the contract skills ride), [ADR-0102/0101/0096/0103](0102-growth-loop.md) (the governed scorers the
  semantic layer wraps), [ADR-0117](0117-self-healing-flywheel.md) (the flywheel an eval regression feeds),
  and [ADR-0035](0035-config-layering.md) (the layered config the `fleet` block plugs into).
- **Reference:** Anthropic, *How Anthropic enables self-service data analytics with Claude* — accuracy is a
  context+verification problem (21% → 95%+ with skills); skills drift (95% → 65% in a month) unless
  maintained as code; agents must be structurally routed to governed definitions before raw data.

> **Numbering note.** ADR/spec/migration all use the `0155` slot (the issue number), per the by-issue
> convention (ADR-0099), to dodge sibling-workspace collisions in the shared migration sequence.

## Context

The fleet agents answered freeform. Two failure modes the playbook names directly: (1) a metric question
("what's our conversion?") could be answered from raw data with a number nobody else would reproduce — no
single source of truth; and (2) any in-prompt guidance the agents carried would silently rot, because
nothing tested it against reality or failed a build when it drifted. We had governed scorers (growth/demand/
venture/moat) but no structural routing *to* them, and no maintenance discipline *around* the guidance.

## Decisions

1. **Skills live in the repo, versioned, per agent.** `platform/agents/skills/<agent>/{knowledge,runbook}.md`
   + a `manifest.json` catalog (id + version + path + checksum-free pointer). Knowledge = a thin router to
   curated reference files, loaded on demand. Runbook = the senior-practitioner procedure (clarify → consult
   governed sources FIRST → execute → self-review). The runtime (#68) learns which skills a session loads via
   a new `AGENT_SKILLS` env var emitted by `subagents/scope.ts personaHarnessEnv` — the same env-not-argv
   contract as the prompt/tools/model, so a hostile skill name can never inject shell.

2. **A semantic layer is the ONLY path to a metric number.** `apps/server/src/semantic/` is a pure
   `METRIC_CATALOG` of canonical metric definitions, each bound to a governed scorer. Lens answers metric
   questions through `SemanticLayerService.answer(workspaceId, metricId)` — one canonical function, so the
   same number everywhere. Raw-data exploration is the documented fallback and is **flagged** in the answer.

3. **Every answer carries provenance + freshness, in brand voice.** `provenance.ts` ranks the path
   (`semantic_layer › curated_reference › raw_data`) and computes freshness against a configurable max-age;
   `answer.ts` renders both in the house voice. A stale or fallback answer says so out loud.

4. **Skills are maintained as code, gated by offline evals.** `apps/server/src/evals/` runs an offline,
   deterministic, **model-free** suite per agent domain (`platform/agents/evals/<agent>.json`). Metric
   questions are graded against the real semantic layer (proving the structural-routing thesis); discipline
   questions are graded against skill-file invariants (provenance-first, brand voice, no autonomous send). A
   run persists `eval_runs` (skill version, git SHA, model id, pass/fail, tokens), logs to Braintrust via the
   existing tracer seam (no-op without a key / when egress is blocked), and **feeds regressions to the #117
   flywheel** as a new `eval_regression` failure class. CI surfaces a before/after delta vs a committed
   baseline.

5. **A migration that moves a metric surface must move the skills with it.** `scripts/check-skill-colocation.mjs`
   (quality-job step, diff-based, dependency-free) fails a PR that changes a governed scorer or a migration
   touching a governed table without a paired change under `platform/agents/skills|evals/`. This is the
   anti-drift latch the playbook calls for, enforced in CI.

6. **The loop compounds into the moat.** A passing eval suite is an `accumulatedEvals` accrual
   (`moat/score.ts`) — `evalAccrualMagnitude` maps suite strength to a moat magnitude, so maintained skills
   literally widen the moat.

## Config & defaults

One `fleet` config block (`enabled`, `freshnessMaxAgeHours`, `evalRegressionTolerance`), default **OFF** —
a deployment that sets nothing surfaces the catalog read-only and runs no proactive eval tick. Reads
(answering a metric, listing the catalog) stay always-on and tenant-scoped (`assertWorkspace`, #19); the
flag gates only the proactive maintenance posture. Block added to all 7 schema/layers sites.

## Consequences

- Lens cannot invent a conversion number; it routes through the catalog or flags a raw fallback.
- Guidance drift is a red build, not a slow accuracy bleed.
- The eval rails (`grade.ts`/`regression.ts`) are written so the constitution scorer (#146) and the
  sources-of-truth catalog (#152) can reuse them when they land — expect a light rebase there.
- No model spend in CI: the suites are deterministic and offline by construction.
