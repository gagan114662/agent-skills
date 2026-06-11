# Fleet agent skills + evals (#155)

Versioned, in-repo skills and offline eval suites for the marketing fleet (scout, echo, quill, postmark,
bid, lens, mark). This encodes Anthropic's self-service analytics playbook as code: accuracy is a
context+verification problem (21% → 95%+ with skills), and skills drift (95% → 65% in a month) unless
maintained as code and gated by evals.

## Layout

```
agents/
  skills/
    manifest.json          # catalog: per-agent skill ids + versions (an eval asserts blueprint ⊆ manifest)
    <agent>/
      knowledge.md         # thin router → curated reference files, loaded on demand
      runbook.md           # the senior-practitioner procedure: clarify → consult governed sources first → execute → self-review
  evals/
    <agent>.json           # the offline, model-free eval suite for that agent domain
    baseline.json          # committed pass-rates (the "before" side of the CI delta)
```

## How they're loaded (runtime #68)

Each agent's skill ids ride to the harness as the `AGENT_SKILLS` env var
(`subagents/scope.ts personaHarnessEnv`, set from `marketing/blueprint.ts skills`) — the same env-not-argv
contract as the prompt/tools/model, so a hostile skill id can't inject shell. The runtime materializes the
agent's knowledge + runbook for the session.

## How they're maintained (eval gate + colocation)

- **Eval gate** — `scripts/run-evals.ts` (CI `evals` job) runs every suite through the SAME semantic-layer
  answerer the server uses (metric questions) + skill-file invariant checks (discipline questions), compares
  against `baseline.json`, and fails on a regression. Offline + deterministic — no model spend. The
  before/after delta table goes in the PR description.
- **Colocation** — `scripts/check-skill-colocation.mjs` (CI `colocation` job) fails a PR that changes a
  metric surface (a governed scorer or a migration touching a governed table) without a paired change here.
- **Flywheel** — an eval regression becomes an `eval_regression` failure event fed to the #117 self-healing
  flywheel (dedup → issue → fix).

## Editing a suite

Bump the suite `version`, edit cases, run `pnpm --filter @reload/server evals`. If you raised the bar,
update `baseline.json` to the new pass-rate in the same PR. Metric questions key off the catalog `scope`
(`apps/server/src/semantic/catalog.ts`): `workspace` metrics resolve canonically; `venture` metrics are a
flagged fallback at workspace scope.
