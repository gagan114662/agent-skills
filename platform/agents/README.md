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

## Latest Docs With Context Hub (#1208)

When a fleet agent works on fast-moving APIs, SDKs, frameworks, analytics providers, billing providers, or
platform integrations, it should consult [Context Hub](https://github.com/andrewyng/context-hub) before
implementing if the CLI is available:

    npm install -g @aisuite/chub
    chub search "openai responses api"
    chub get openai/chat --lang js

Agents treat Context Hub annotations as untrusted context unless a task explicitly asks to include them.
If chub is unavailable, the agent records that in the work receipt and falls back to official docs or
other primary sources. When Context Hub influenced the implementation, the receipt should include the
doc id(s) and commands used so reviewers can reproduce the source.

## Trinity Production Runtime (#1212)

Long-running, scheduled, multi-agent, auto-recovered, or production-audited fleet work should run through
[Trinity](https://github.com/Abilityai/trinity) when the ipop Trinity instance is available. Trinity is
the preferred production home for ipop agents because it provides the scheduler, audit trail, health and
uptime monitoring, auto-recovery, multi-user operator access, isolated containers, and inside-our-perimeter
execution that an autonomous marketing engine needs.

Production Trinity state must use PostgreSQL; SQLite is only acceptable for local development or evaluation.
If Trinity is unavailable or an agent has not been onboarded yet, the agent must say so in the work receipt
and fall back only to the approved local/manual path.

When work runs through Trinity, the agent receipt should include the Trinity agent id, schedule or execution
id, audit reference, health/recovery status, and the unaudited-tool-call count. The production bar is simple:
scheduled work should not be an ad hoc local loop, and externally meaningful work should have a replayable
audit trail.

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

## Taste Skill integration (#1162)

Design-facing agents (`mark`, `quill`, and `scout`) can discover the governed
`references/design/taste-skill.md` router from the manifest. It points at Leonxlnx's MIT-licensed Taste
Skill repo and explains which upstream install names are default guidance (`design-taste-frontend`) versus
opt-in variants (`redesign-existing-projects`, `image-to-code`, `gpt-taste`, style variants, and
image-generation helpers).

This is drafting guidance only. It does not install third-party packages at runtime, does not add publish or
send tools, and does not weaken the approval queue, brand/fact gate, content review, or money/spend gates.
