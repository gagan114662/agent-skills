# Spec #171 — Self-QA Loop: the platform tests its own product like a human QA

> Owner directive (verbatim): *"I have been babysitting all day — make issues on your own."* The owner
> hand-tested the app and wrote a 13-bug QA report (issues 166–169) the platform should have produced
> itself. This loop closes that gap: a synthetic user drives the **live** product on a schedule, and
> every failed expectation becomes a deduped, owner-quality GitHub issue — filed by the platform, not a
> human.

- **Status:** Accepted
- **Issue:** [#171](https://github.com/gagan114662/agent-skills/issues/171)
- **ADR:** [docs/adrs/0171-self-qa-loop.md](../adrs/0171-self-qa-loop.md)
- **Builds on:** #117 self-healing flywheel (the deduped failure → issue ledger), #108 uptime monitor
  (the stateless GitHub label-marker dedup-filing pattern run from CI with a token), #148 reliability
  surface (`PagerService` — page the verified owner at critical), #71 scale caps (the dollar ceiling),
  #99 maintenance flag, #17 kill switch, #25 secret redactor.

## Problem

The product breaks in ways that only a human clicking around notices: horizontal overflow, a button that
does nothing, a popover that won't close, a session that never replies. We have loops that watch
*infrastructure* (uptime #108, SRE #112, watchdog #105) but nothing that exercises the *product surface*
the way a QA engineer would. So the owner does it by hand and files the bugs.

## Goal

A scheduled, headless, synthetic-user E2E QA pass against the live product that:

1. Signs in, switches channels, inserts templates, @mentions an agent, opens every tab, clicks every
   primary action, and asserts the invariants a human QA checks: **no horizontal overflow**, **no dead
   buttons** (a click has an observable effect), **no stuck popovers** (Escape / outside-click closes),
   **sessions actually produce replies**.
2. Turns each failed check into a **structured bug finding** (surface, repro steps, severity, evidence
   path) via a pure, deterministic classifier with stable dedup fingerprints.
3. Files those findings as **deduped GitHub issues** at the same quality bar as the owner's report
   (grouped by surface, repro, acceptance criteria, severity labels). Repeat findings comment on the
   existing issue — never spam a new one.
4. Runs **nightly** (full pass) and **post-deploy** (smoke subset). Critical findings **page the owner**
   (and only the owner, only at critical) via the #148 seam.
5. Operates in a **dedicated, clearly-flagged synthetic workspace** that is tenant-isolated, budget-
   capped, and never mixes with real customer data. No secrets in artifacts; evidence paths scrubbed.

## Non-goals

- Not a replacement for unit/integration tests — it tests the *deployed product*, black-box.
- Not auto-fixing the bugs it finds (that is the flywheel's #92 dispatch, opt-in and separate). This
  loop's job is to **find and file**.
- No new web UI in this slice. Findings surface as GitHub issues + (when the server engine is on) the
  flywheel ledger / #104 console rows.
- The real Playwright driver is **optional** (lazy, env-gated). The default CI run uses a dependency-free
  HTTP smoke driver so the nightly job needs no browser binary and no lockfile churn.

## Design

### Pure core (TDD)

The testable heart has no IO — a raw check result in, a structured finding out, a stable signature out:

- **`catalog.ts`** — the synthetic-user check catalog as pure data. Each check declares `id`, `surface`,
  `suite` membership (`smoke` ⊂ `full`), human `title`, `steps` (the repro), the `expectation`, and the
  `severityOnFail`. This is the script a human QA would follow, encoded once.
- **`classify.ts`** — `classifyResults(results, catalog)`: maps each *failed* raw result to a structured
  `QaFinding` (surface, severity, numbered repro steps, expected vs actual, evidence path). Deterministic;
  unknown check ids are dropped, not guessed.
- **`fingerprint.ts`** — `fingerprintFinding(finding)`: a stable 16-hex signature over
  `surface + checkId + failureKind`, scrubbed of volatile tokens (run id, timestamp, screenshot path) so
  the *same* bug collides to *one* signature run-over-run. This is the dedup key.
- **`render.ts`** — owner-quality issue presentation: `renderFindingTitle`, `renderFindingBody` (surface,
  severity, repro, expected/actual, evidence, acceptance criteria, the dedup marker comment),
  `findingLabels` (`selfqa`, `selfqa:<surface>`, `severity:<sev>`), and `toFailureEvent` (the bridge to a
  #117 flywheel `FailureEvent`). Every render site reads only already-scrubbed fields.

### IO seams

- **`driver.ts`** — the `QaBrowserDriver` seam: `run(check, ctx) → RawCheckResult`. Implementations:
  - `noopDriver` — returns healthy for every check (the safe default; used in unit tests and when
    unconfigured).
  - `httpSmokeDriver` — dependency-free, uses global `fetch` to assert the live web + API are reachable
    and healthy. The "or equivalent" headless pass that runs in CI without a browser.
  - `createPlaywrightDriver()` — **lazily** `import("playwright")` only when `SELFQA_DRIVER=playwright`
    and the package is installed; otherwise throws a friendly, actionable error. No hard dependency.
- **`runner.ts`** — `SelfQaRunner.run({ suite, target, workspaceId })`: gates on `enabled` /
  kill-switch / maintenance / budget, selects the suite's checks, runs each via the driver, classifies
  the failures, returns `{ findings, summary }`. Scoped to the synthetic workspace id only.
- **`bridge.ts`** — the `FindingReporter` seam. Two impls share the pure core:
  - `flywheelReporter(engine)` — records each finding into the #117 flywheel (`qa_failure` class) so it
    flows through the existing deduped-fingerprint ledger and can later be auto-dispatched.
  - `githubReporter(provider, repo, token)` — the stateless CI path: dedups via a GitHub label +
    `<!-- selfqa:<signature> -->` body marker (the #108 pattern), opens on first sight, comments on
    recurrence, never spams. Critical findings also page the owner via `PagerService`.
- **`engine.ts` / `default.ts`** — `SelfQaEngine` ties runner + reporter + config; default-OFF; the
  background timer is opt-in (`SELFQA_INTERVAL_MS`, default 0), wired in `app.ts`/`index.ts` like every
  other loop.
- **`run-cli.ts`** — `pnpm --filter @reload/server selfqa:run --suite smoke|full --target <url>`. The
  CI entrypoint, modeled on the uptime CLI: fail-soft (a probe error is a *finding*, never a crash),
  exits non-zero when any critical finding is open so the workflow goes red even without a token.

### Durable state — migration `0171_self_qa_loop`

One lean table, `selfqa_runs` (run history for observability and the #104 console): `id`, `workspace_id`
(FK, cascade), `suite`, `target`, `status` (`running|passed|failed`), `started_at`, `finished_at`,
`checks_total`, `checks_failed`, `critical_count`. Findings themselves are **not** re-stored — dedup lives
in the flywheel (DB path) or in GitHub (CI path). DRY: one dedup store, not two.

### Tenant isolation, budget, secrets

- **Synthetic workspace.** A reserved-slug workspace (`RELOAD_SELFQA_WORKSPACE_SLUG`, e.g.
  `selfqa-system`). The runner refuses to operate on any other workspace id. All synthetic rows are
  scoped under it; the `workspace_id` boundary (cascade on every table) keeps it isolated from real
  tenants. It is clearly flagged in every issue body and run row.
- **Budget cap.** Reuses the exact #71 `budgetExhausted` check against the synthetic workspace's
  `[scale].budgetCents`, so synthetic sessions are dollar-capped like any tenant.
- **Secrets.** Findings carry no credentials (the synthetic workspace uses synthetic creds). Defensively,
  every rendered string passes the #25 redactor, and evidence/screenshot paths are scrubbed of query
  strings and tokens before they reach an issue body or a log.

## CI cadence

- **`.github/workflows/selfqa-nightly.yml`** — `schedule` cron (nightly) + manual dispatch.
  `permissions: issues: write`; runs `selfqa:run --suite full` against `https://ipop.ai` with the HTTP
  smoke driver and the Actions `GITHUB_TOKEN`. Opens/dedups issues; pages the owner at critical (opt-in).
- **`fly-deploy.yml`** — after the post-deploy readiness check, a `selfqa:run --suite smoke` step runs the
  critical/high subset against the just-deployed API/web so a regression is caught within minutes.

## Acceptance criteria

- [ ] `selfqa:run --suite smoke|full --target <url>` probes the live product and prints a per-check pass/fail.
- [ ] A failed check becomes a structured finding (surface, repro, severity, evidence) — pure + unit-tested.
- [ ] Findings dedup deterministically (same bug → one signature → one issue; recurrence → a comment).
- [ ] Issues are owner-quality: grouped by surface, with repro, acceptance criteria, and severity labels.
- [ ] Nightly full pass + post-deploy smoke wired in CI; critical pages the owner via #148.
- [ ] Synthetic workspace is isolated, budget-capped, clearly flagged; no secrets in artifacts.
- [ ] The pure classifier + fingerprint modules are TDD'd; spec + ADR shipped.
