# Spec: Reload Platform — Self-Shipping Loop: agent-ok issues → cloud build agents → auto-merge within guardrails (Issue #172)

> Implements [#172](https://github.com/gagan114662/agent-skills/issues/172). Phase — the company runs
> itself. **Builds on #117** (the supervisor pattern: opt-in tick, kill-switch/maintenance gating,
> durable bounded tables, pure `decide`/`guards` + IO engine, #92 launcher reuse, #13 escalation, #104
> console pane, #25 redactor) and **#115** (the dispatch loop). Reuses **#92/#84** (`AutonomyLauncher`
> seam → real build sessions, subscription/platform auth via #68), **#71** (`tenant_usage` dollar
> ceiling), **#13/#95** (approval gates + sensitive-by-default), **#99** (maintenance Redis flag),
> **#148** (owner escalation). Lifecycle: DEFINE → atomic plan → TDD → ADR → one PR. **Video gate
> waived by the owner.**

## Objective

**What:** Today a human-driven loop ships PRs by hand: file issue → dispatch a Conductor build seat →
line-by-line review → CI → merge → rebase-train → deploy → verify. That exact loop becomes platform
infrastructure — a **tick-driven supervisor** (mirroring the #117 flywheel) that watches `agent-ok`
issues, dispatches cloud build agents, auto-reviews their PRs against the house rubric, and **auto-merges
ONLY within guardrails**, escalating everything else to the owner instead of merging.

Six stages:

1. **Auto-dispatch** — `recordIssue` (a route, or the optional `IssueSource` watch path) upserts an
   `agent-ok` issue into a workspace-scoped `build_loop_runs` row (dedup by issue ref — ONE run per
   issue is a DB UNIQUE invariant). The tick picks the next by **priority then dependency** (a blocked
   issue waits for its dependency to merge), and dispatches a build session through the #92 launcher
   under a **hard concurrency cap** and the **#71 per-tenant dollar ceiling**.
2. **Auto-review** — when the build agent opens a PR, a **reviewer** (a different agent in production;
   the pure **house rubric** by default — zero spend, deterministic) judges the diff against the issue's
   acceptance criteria + the house rubric (**gates intact, tenant scoping, migrations numbered by issue,
   tests present, no secrets**) and posts a structured verdict comment with file+line evidence. A FAIL
   verdict routes the findings back to the build agent (a **revise** round); after `maxReviewRounds`
   FAILs it escalates.
3. **Auto-merge within guardrails** — the merge happens ONLY when **ALL** hold: reviewer **PASS**, CI
   **green**, **no protected gate/policy/billing/secrets path touched**, diff **under the size cap**, and
   the issue is **agent-ok**. The decision is the pure `decideMergeGuardrails`, which fails closed on the
   FIRST violated guardrail. Anything outside guardrails **escalates to the owner** (#13 queue / #148
   pager) — never a silent merge, never a destructive override.
4. **Rebase-train** — `onMainMoved` asks every open PR to merge-from-main; a conflict routes the PR back
   to its build session (`revising`), a clean update continues.
5. **Post-merge verify** — after a merge, an optional verifier runs smoke + the #171 self-QA subset; a
   regression **PROPOSES** a revert to the owner (criterion 5: auto-revert is **never executed**).
6. **Audit + console + kill switch** — every loop action is a durable row (`build_loop_runs` +
   `build_loop_reviews`, the append-only review ledger), surfaced in the #104 Founder Console pane (loop
   status, queue, in-flight, merge history, escalations). The #17 kill switch stops the loop instantly.
   **Default-OFF.**

**Why:** The owner has run this loop by hand for 15+ PRs. Platform-ifying it removes the human from the
mechanical path while keeping every safety gate the owner relied on — and makes "outside guardrails →
human" a structural property, not a discipline.

## Non-goals

- **Wiring a real GitHub merge/rebase backend.** The `RepoHost` seam models observe-PR / diff / CI /
  comment / merge / merge-from-main; the default is a **no-op** (no credentials) so CI never ships. A
  deployment injects a `gh`-backed `RepoHost` (a thin adapter over `gh pr merge` / branch update) — the
  contract is here, the credentials stay on the #25 path.
- **A new audit subsystem.** Escalations route through the existing #13 queue (appear as
  `approval.buildloop.escalate` in the audit feed); the loop's own ledger (runs + reviews) is the
  full-action audit surface read by the console.
- **Changing `approvals/policy.ts` or any gate.** Promotion reuses the existing #13 gate; protected-path
  PRs always require a human.

## Architecture

Pure decision core (unit-tested) + IO engine (integration-tested against fakes), exactly the #117 split:

- `build-loop/guardrails.ts` — pure predicates: `matchesGlob`/`isProtectedPath` (the
  gate/policy/billing/secrets human-review trigger), `diffWithinSizeCap`, `buildCapacityAvailable`,
  `reviewRoundsExhausted`. `DEFAULT_PROTECTED_PATHS` is the structural expression of "gates intact".
- `build-loop/rubric.ts` — pure `evaluateHouseRubric`: the auto-review spine (tests_present,
  migrations_numbered, tenant_scoping, no_secrets, gates_intact) → PASS/FAIL + per-check evidence.
- `build-loop/decide.ts` — pure decisions: `decideNextIssue` (priority + dependency), `decideDispatch`,
  **`decideMergeGuardrails`** (the safety core, fail-closed), `decideReviewOutcome`, `decideRebase`,
  `decidePostMerge`.
- `build-loop/caps.ts` — `resolveBuildLoopCaps` over the layered config; **default OFF**.
- `build-loop/render.ts` — build/review/revise task prompts, the structured verdict comment, the
  redacted findings bundle, the owner escalation summary.
- `build-loop/engine.ts` — the `BuildLoopEngine` supervisor: `recordIssue`, `tickWorkspace`
  (ingest → advance in-flight runs one step → dispatch queued under the cap), `onMainMoved`, with every
  side effect behind an injected seam (`RunStore`, `ReviewStore`, `RepoHost`, `BuildLauncher`,
  `Reviewer`, `Escalator`, optional `PostMergeVerifier`/`IssueSource`).
- `build-loop/default.ts` — production wiring: real repos, #92 launcher, rubric reviewer, no-op repo
  host, #13 escalator. Default-OFF + no-op repo ⇒ wired-but-inert until an operator opts in.

### Persistence (migration `0172_self_shipping_loop.sql`, numbered by ISSUE per ADR-0099)

- `build_loop_runs` — one run per agent-ok issue. `UNIQUE(workspace_id, issue_ref)` makes "one run per
  issue" a DB invariant. Lifecycle status (`queued`→`building`→`reviewing`→`revising`→`merging`→`merged`
  | `escalated` | `failed`), PR linkage, the review-round counter (bounds auto-revise), the merge ref
  (merge history), the escalation reason (out-of-guardrail audit). `workspace_id` is the #3 tenant
  boundary (`ON DELETE CASCADE`); session ids are soft references.
- `build_loop_reviews` — the append-only reviewer-round ledger: every verdict + **REDACTED** findings.

### Gating (identical to the #117 flywheel)

`maintenancePaused` (#99) before any DB call in `tickAll`; then per-workspace `caps.enabled` and the #17
kill switch gate the whole pass. `decideDispatch` additionally checks the #71 budget. Auto-merge is
bounded by every cap even when enabled.

## Acceptance criteria → implementation

| # | Criterion | Where |
|---|-----------|-------|
| 1 | Auto-dispatch by priority/dependency, concurrency cap, per-issue budget | `decideNextIssue`/`decideDispatch`, `tickWorkspace` dispatch loop |
| 2 | Reviewer judges diff vs rubric, posts verdict, FAIL→build, max N rounds | `evaluateHouseRubric`, `reviewRun`, `decideReviewOutcome` |
| 3 | Merge only when reviewer PASS + CI green + no protected path + size cap + agent-ok; else escalate | **`decideMergeGuardrails`**, `evaluateMerge` |
| 4 | Rebase-train on main move; conflicts route back | `onMainMoved`, `decideRebase` |
| 5 | Post-merge verify; regression auto-files + PROPOSES (never executes) revert | `evaluateMerge` post-merge block, `decidePostMerge` |
| 6 | Full audit + console pane; kill switch; default-OFF | `build_loop_*` tables, #104 pane, `caps.enabled` + kill switch |
| 7 | Pure modules unit-tested; integration with a fake repo host; spec + ADR | `test/unit/build-loop-*`, `test/integration/build-loop.test.ts`, this spec + ADR-0172 |

## Testing

- **Unit (43 tests):** `build-loop-guardrails` (glob matcher, protected paths, size/round caps, caps
  resolution), `build-loop-rubric` (every rubric check + render), `build-loop-decide` (queue ordering,
  dependency gating, the merge-guardrail fail-closed order, revise-then-escalate, rebase, post-merge).
- **Integration (2 tests, real Postgres + fake repo host):** dedup + concurrency-cap dispatch + clean
  auto-merge + kill-switch skip + disabled-workspace isolation; and protected-path → escalate (never
  merge) + FAIL→revise→escalate-after-max-rounds + redaction of persisted review findings.

## Security

No secrets in code or logs: the no-op repo host carries no credentials (CI never reaches GitHub); a real
`RepoHost`/reviewer redacts session text at its seam; review summaries/findings and escalation summaries
pass through the #25 redactor before persistence/posting (asserted in the integration test). Tenant
scoping via `workspace_id` on every query. Protected gate/policy/billing/secrets paths can never
auto-merge.
