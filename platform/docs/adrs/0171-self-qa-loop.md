# ADR-0171: Self-QA Loop — a synthetic user E2E-tests the live product and files its own bugs

- **Status:** Accepted (shipped in PR for #171)
- **Date:** 2026-06-12
- **Context issue:** [#171](https://github.com/gagan114662/agent-skills/issues/171)
- **Spec:** [docs/specs/171-self-qa-loop.md](../specs/171-self-qa-loop.md)
- **Builds on:** [ADR-0117](0117-self-healing-flywheel.md) (deduped failure → issue ledger; `qa_failure`
  joins its taxonomy), the #108 uptime monitor (the stateless GitHub label + body-marker dedup-filing
  pattern, run from CI with the Actions token), [ADR-0148](0148-reliability-surface.md) (`PagerService`:
  page the verified owner, email-first, at critical), [ADR-0040](0040-cloud-scale.md) (the `tenant_usage`
  dollar ceiling), [ADR-0099](0099-disaster-recovery.md) (maintenance Redis flag), [ADR-0025](0025-cloud-execution.md)
  (secret redactor).

> **Numbering note.** Spec / migration / ADR all use the `0171` slot (the issue number), per the
> by-issue numbering convention (ADR-0099's note) — chosen to dodge sibling-workspace collisions in the
> shared migration sequence.

## Context

The owner spent a day hand-testing the product and filed a 13-bug report (#166–#169): overflow, dead
buttons, stuck popovers, sessions that never reply. We instrument *infrastructure* (uptime, SRE,
watchdog) but never the *product surface*. The directive: the platform should QA itself like a human and
file its own bugs, so the owner stops babysitting.

## Decision

Add a `selfqa/` loop module that mirrors the established supervisor shape (pure decision core + IO
seams, opt-in, gated, durable bounded state) and **reuses** rather than reinvents the issue-filing
machinery.

### 1. The pure core is the testable contract (TDD)

`catalog` (the QA script as data) → `classify` (raw result → structured finding) → `fingerprint` (stable
dedup signature) → `render` (owner-quality issue body/labels + the flywheel `FailureEvent`). No IO, no
clock, no randomness in the core: the same failed check always yields the same finding and the same
signature, which is what makes "same bug twice = one issue" a property, not a hope. These modules are
written test-first.

### 2. Two delivery paths, one core — "flow through the #117 flywheel" without coupling CI to the DB

A `FindingReporter` seam has two implementations over the shared pure core:

- **Server / flywheel path** (`flywheelReporter`): when the in-process `SelfQaEngine` is enabled, each
  finding is `record()`-ed into the #117 flywheel as a `qa_failure`. It flows through the existing
  deduped `failure_fingerprints` ledger, surfaces in the #104 console, and is eligible for opt-in #92
  auto-dispatch — exactly the integration the issue asks for.
- **CI path** (`githubReporter`): the nightly/post-deploy CLI has a token but no DB (it must never touch
  the prod database). It dedups the way the #108 uptime monitor proved out — a `selfqa` label plus a
  `<!-- selfqa:<signature> -->` body marker — opening on first sight, commenting on recurrence, never
  spamming. Same signature from the same pure core ⇒ both paths agree on identity.

We deliberately did **not** route CI issue-filing through the flywheel's background tick: that would
require the stateless Action to open a connection to the production database. The flywheel's own filer is
a no-op by default, so a real CI tool files through the #57/#108 `GitHubIssueProvider` directly — the
same provider the flywheel is meant to use in a real deployment.

### 3. The driver is a seam; the real browser is optional

`QaBrowserDriver` defaults to a no-op (tests) and ships a dependency-free `httpSmokeDriver` (global
`fetch`) for CI. A real Playwright driver is `import()`-ed **lazily** behind `SELFQA_DRIVER=playwright`,
so the package is never a hard dependency and the lockfile / `--frozen-lockfile` CI install is untouched.
"Playwright or equivalent" — equivalent by default, Playwright on opt-in.

### 4. Isolation, budget, secrets

A reserved-slug **synthetic workspace** (`RELOAD_SELFQA_WORKSPACE_SLUG`) is the only workspace the runner
will touch; every synthetic row lives under its `workspace_id`, inheriting the cascade-scoped tenant
boundary. Budget is the same #71 `budgetExhausted` ceiling against the synthetic workspace's
`[scale].budgetCents`. Findings carry no secrets; every rendered string is run through the #25 redactor
and evidence paths are scrubbed before they reach an issue or a log.

### 5. Durable state — migration `0171_self_qa_loop`

One table, `selfqa_runs` (run history for observability + the #104 console). Findings are not re-stored;
dedup lives in the flywheel (DB path) or GitHub (CI path) — one dedup store, never two.

## Consequences

**Positive.** The product now QA's itself: a regression that a human would catch by clicking around
becomes a deduped, owner-quality issue within minutes of a deploy and again every night — without the
owner. The pure core is fully unit-tested and deterministic. Nothing changes until an operator opts in
(default-OFF config + `SELFQA_INTERVAL_MS=0`); the CI CLI is the always-on entry and is fail-soft.

**Negative / trade-offs.** The default CI driver is HTTP-smoke, not a real browser, so the nightly job
catches *reachability/health* regressions out of the box; the full click-through assertions (overflow,
dead buttons, stuck popovers) require enabling the Playwright driver in a follow-up runner image. The
two-path reporter means the dedup identity is shared by the pure fingerprint but the *stores* differ
(flywheel DB vs GitHub markers) — acceptable, because the fingerprint is the single source of identity.

## Alternatives considered

- **Route everything through the flywheel tick.** Rejected: forces the stateless CI Action onto the prod
  DB and couples QA cadence to the server runtime.
- **A second findings table + bespoke dedup.** Rejected as not-DRY: the flywheel already owns deduped
  failure identity; we reuse it and let GitHub be the dedup store on the CI path.
- **Hard Playwright dependency.** Rejected: heavy install, lockfile churn, and a `--frozen-lockfile` CI
  risk for a driver that is optional by design.
