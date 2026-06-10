# ADR-0037 — Cloud e2e / soak proof via one dual-mode harness

**Status:** Accepted · **Issue:** #68 · **Date:** 2026-06-09

## Context
The gap sprint merged the cloud runtime (#25), the real harness (#50), and #51–#59. But the core
loop — a real agent running in a sandbox, streaming, and being reaped — had run exactly once against
an empty sandbox. We need ongoing, repeatable proof that it works, and that it holds under
concurrency, without forcing cloud spend in CI.

## Decision
Ship **one** soak harness (`scripts/cloud-e2e-soak.ts`) that drives N concurrent sessions through
`createRuntime` + the configured harness, and works in two modes selected purely by env:
- `local` (default) → real child processes, no spend; the spend-free evidence for CI/dev.
- `sandbox` + `claude-code` + `VERCEL_*` → the billable live proof.

Driving the **runtime directly** (not the SessionManager) keeps the harness DB/Redis-free and
runnable anywhere, while still exercising the exact provision → run → stream → snapshot → teardown
path. `wait()` resolving for every session is the reaping proof.

## Why this shape
- **One code path, two modes** means the spend-free local run and the billable cloud run prove the
  *same* orchestration — local isn't a different mock.
- **Opt-in, zero default change**: CI keeps running `local`/`demo`; nothing new is forced on anyone.
- **No DB dependency** → the harness runs in any environment, including a fresh sandbox image.

## Consequences
- The live `sandbox`+`claude-code` proof needs the `claude` binary + Vercel auth in the environment;
  it's a human-run, billable step (same constraint as the #25 smoke test), not a CI gate.
- Idle/wall-clock reaper behavior under load is asserted by existing SessionManager tests, not here;
  deepening that is a follow-up.

## Alternatives considered
- **Drive through SessionManager** (DB-backed) for a more "real" path — rejected: it needs
  Postgres/Redis, can't run in a bare sandbox, and adds nothing to the runtime-level proof.
