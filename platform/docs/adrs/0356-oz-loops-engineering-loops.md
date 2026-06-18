# ADR-0356: Adopt oz-for-oss engineering-loop patterns (triage / spec / review / pr-comment), gated

- **Status:** Accepted (gated in-repo logic + guidance; nothing enabled in production) (shipped in PR for #356)
- **Date:** 2026-06-18
- **Context issue:** [#356](https://github.com/gagan114662/agent-skills/issues/356) — run the same
  open-source engineering loops oz-for-oss runs (issue triage, spec generation, code review, PR-comment
  response) on the ipop department fleet.
- **Builds on:** [ADR-0013](0013-approval-gates.md) (the #13 owner-approval queue — the only way to act on a
  proposal), [ADR-0200](0200-premortem-panel.md) (the standing premortem whose rails this answers to),
  [ADR-0243](0243-money-only-approval.md) (the publish action is a non-money structural always-gate),
  [ADR-0283](0283-skillopt-sleep.md) (the *separate* self-improvement loop this must not duplicate).
- **Precedent:** mirrors the [lavish-axi](../../../docs/lavish-axi.md) (#344) and
  [no-mistakes](../../../docs/no-mistakes.md) (#350) adoptions — same opt-in / advisory / DEFAULT-OFF,
  owner-first, #200-honoring, third-party-trust-noted shape, applied to a new surface.

## Context

[`oz-for-oss`](https://github.com/warpdotdev/oz-for-oss) (MIT, Python) is Warp's reusable open-source
automation platform: a *hosted* "Oz" agent that triages issues, drafts product/tech specs, opens
implementation PRs, reviews PRs, responds to PR comments, and verifies changes via slash commands. Its
intelligence lives in agent skills under `.agents/skills/` (e.g. `triage-issue`, `dedupe-issue`,
`create-product-spec`, `create-tech-spec`, `review-pr-local`, `verify-pr`) plus a prompt-construction
layer, delivered through a **Vercel webhook control plane** and a **GitHub App**.

The fleet raises and reviews PRs and triages its own issues. Running these four loops would let the fleet
do that work consistently — *if* it can be done without the standing third-party trust and without giving
untrusted issue/PR/comment content any authority.

Two hard realities shaped the decision:

1. The *hosted* oz-for-oss product requires the owner to install Warp's **GitHub App**, deploy a **Vercel**
   control plane, and obtain an **Oz OSS-partnership credit grant**. That is real, ongoing third-party
   trust and standing config — exactly what #200 says must not be wired in silently.
2. These loops ingest the most untrusted content the fleet sees — issue bodies, PR diffs, and review
   comments from anyone. If any of that were treated as instructions, an attacker could file an issue that
   makes the fleet act.

## Decision

Adopt the **open-source skill/prompt PATTERNS** as **gated in-repo logic + guidance**, mirroring #344/#350.
Build + PR only; nothing enabled in production:

- **In-repo logic** at `platform/apps/server/src/oz-loops/` — four PURE, advisory-only decide functions
  (`decideTriage`, `decideSpecDraft`, `decideReview`, `decidePrCommentResponse`), an injection-defense
  sanitizer, caps (default OFF, owner-first), and a thin service whose only outward path stages a #13
  request. A new config block `ozLoops` (schema + layers + env loader), and a new
  `oz_loops.publish_proposal` approval action.
- **Guidance** in [`AGENTS.md`](../../../AGENTS.md), [`CLAUDE.md`](../../../CLAUDE.md), and a full reference
  at [`docs/oz-loops.md`](../../../docs/oz-loops.md).
- **A guidance validator** (`scripts/validate-oz-guidance.js`, wired into CI) asserting the safety rails are
  present and that **no fabricated oz-for-oss skill names** leak into the docs (every cited skill is checked
  against the verified `.agents/skills/` set).

Five rails are encoded **structurally** so they do not depend on agent goodwill:

1. **DEFAULT-OFF, owner-workspace-first.** `resolveOzLoopsCaps` defaults `enabled:false`,
   `ownerWorkspaceOnly:true`; `isOzLoopsEnabledForWorkspace` returns false unless the master flag is on AND
   the workspace is the named owner. Enabling without naming an owner runs for nobody. The service is
   fail-closed: a disabled workspace produces nothing and stages nothing.

2. **Advisory only — the #13 gate is the only way to act.** Every output carries `advisory: true`. No
   close/merge/label/post path exists in the module. `requestPublish` parks a PENDING
   `oz_loops.publish_proposal` request; it is NOT a money action (ADR-0243) and never goes through the
   auto-evaluate route, so it always waits for the owner. The executor is recorded-only; the live GitHub
   post is an owner-gated follow-up.

3. **Injection defense (#200 §6).** Issue bodies, PR diffs, and comments are untrusted DATA. The decide
   logic reads only structural signals; free text is sanitized (control chars stripped, length-capped) and
   only echoed inside a marked DATA block; an instruction-injection attempt is flagged and refused, never
   followed. Nothing ingested can widen the agent's permissions or scope.

4. **Third-party trust note + hard boundaries.** The hosted product's GitHub App, Vercel control plane, and
   OSS-partnership credit grant are flagged as owner-gated. This change installs no App, stands up no Vercel
   control plane, and modifies no repo webhooks/permissions/settings.

5. **No duplication of #283.** These loops are scoped to triage/spec/review/pr-comment; the self-improvement
   cron loop is SkillOpt-Sleep (#283/#310/#331), referenced not reimplemented.

## Consequences

- **The fleet can run four consistent engineering loops** once an owner opts in — advisory, gated, and safe
  against the untrusted content they ingest.
- **Nothing executed.** No money, no credentials, no live GitHub actions, no App installed, no control plane
  deployed by this change. The loops are inert until the owner sets the flag, and even then only stage #13
  proposals.
- **No fabrication.** The oz-for-oss skill names cited in our docs are verified against the project's
  `.agents/skills/` directory, and CI fails if an unverified name appears.
- **Reversible.** Removing the `oz-loops` module, the config block, the approval action, and the docs fully
  reverts the decision; default behavior is byte-for-byte unchanged when the flag is unset.
- **Optional owner step (future, separate decisions):** adopting the *hosted* oz-for-oss product (install
  the GitHub App, deploy the Vercel control plane, obtain the partnership credit grant); wiring the live
  `gh`/GitHub-App post behind the #13 gate for an approved `oz_loops.publish_proposal`.
