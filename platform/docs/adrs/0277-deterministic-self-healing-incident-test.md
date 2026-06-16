# ADR-0277: Stabilize the self-healing-incident integration test by synchronizing on the asserted state, not a status proxy

- **Status:** Accepted
- **Date:** 2026-06-16
- **Context issue:** [#277](https://github.com/gagan114662/agent-skills/issues/277)
- **Builds on:** [ADR-0174](0174-self-healing-ops.md) (the `RemediationStore` seam + `selfHealingOps` surface), the #238 spawn-incident and #242 model-incident hooks (`onSessionFailure`/`onSessionRecovered` wired in `runtime/manager.ts`), and the #248 deliverable-card test which already used condition-based polling for the same hook-after-finalize timing.

## Context
The `integration` CI job intermittently failed on `test/integration/agent-sessions.test.ts` — `'a spawn failure OPENS a self-healing ops incident, and a later success RESOLVES it (#238)'` — with `AssertionError: expected [] to have a length of 1 but got +0`. `main` was green on the same commit; the failure was unrelated to the PR under test (e.g. seen on #275, which only touches connections/publishing). It fired only under shared-Postgres load (sibling Conductor workspaces / concurrent processes on one PG), forcing a manual rerun before nearly every merge — false reds blocking the merge train.

## Root cause
In `SessionManager.runSession` (`src/runtime/manager.ts`), a terminal session is written in this order, and the order is **intentional**:

1. `await this.deps.store.finalize(session.id, { status, exitCode, result, … })` — writes the session's terminal status. This is the source-of-truth row, and it is what the test's `pollStatus(... s === "failed")` observes over HTTP.
2. **Strictly afterward**, the best-effort `onSessionFailure` / `onSessionRecovered` hooks run (each `.catch()`-wrapped) and write/resolve the self-healing incident row. These are deliberately post-finalize so an incident-recorder hiccup can never block or fail an already-finalized session (the #230/#238 contract).

So a session reaching `failed`/`completed` does **not** imply the incident row has been written/resolved — that is a separate, strictly-later DB round-trip. The test asserted `listOpenRemediations(...)` **immediately** after the status poll returned, racing the post-finalize write. Under PG contention the second round-trip lagged past the assertion → `[]` → "expected length 1, got 0". The recovery assertion (`length === 0` after a completion) and the parallel #242 test had the identical race; only the #248 test had already adopted condition-based polling for this exact timing.

A **second, deeper instance of the same class** surfaced only under heavy concurrent stress: `recordModelFailureIncident` (`src/self-healing/model-incident.ts`) writes the model incident in **two** round-trips — `store.open` creates the row (the `RemediationStore.open` insert has no `detail` column; it does set `status`/`surfaceKey`/`signal` atomically) and a separate `store.update` then sets `detail`. So even once the row exists, `detail` is briefly `null` until the second write commits — and asserting `detail` could catch the row in that gap (`AssertionError: … (null and string) is invalid for this assertion`). The spawn test only asserts `open()`-written fields, so it has no such sub-gap.

## Decision
Fix the **test's synchronization point**, not the production ordering (which is correct: finalize-before-incident, best-effort, must-never-block). Wait for the **actual asserted state** — the remediation rows — rather than the session-status proxy. This is condition-based waiting (`superpowers:systematic-debugging` → `condition-based-waiting`), explicitly endorsed by the issue ("make the test await the incident row"). It is **not** a blind sleep, retry, or `test.skip`: it returns the instant the real post-finalize write is visible, and throws a clear, bounded error on genuine failure.

1. **New `waitForRemediations(workspaceId, until, description, timeoutMs = 10_000)` helper** — mirrors the existing `pollStatus` deadline pattern, polling `listOpenRemediations` every 25ms until the predicate holds, returning the rows (so field assertions run on the settled snapshot). It reuses the existing `listOpenRemediations` test seam — no new fixtures.
2. **#238 + #242 assertions synchronize on the rows.** Open transitions wait for `r.length === 1`; resolve transitions wait for `r.length === 0`. The detailed field assertions (`surfaceKey`/`signal`/`status`) then run on the returned snapshot.
3. **The model "open" wait also requires the fully-committed `detail`** (`r.length === 1 && r[0].detail?.includes("claude-fable-5")`) so it never catches the row in the gap between `store.open` and the `store.update` that sets the cause.

No production code, schema, or contract changed — money-only gating (#243) and injection-quarantine (#223) are untouched. The change is test-only.

## Consequences
- The merge train stops eating false reds from this suite; reruns are no longer a ritual.
- The fix is **deterministic, not probabilistic**: it does not depend on the write happening to land within an arbitrary delay.
- The two-write `open`-then-`update` in `model-incident.ts` is left as-is (a brief detail-less incident in the console is harmless and self-corrects on the next write); the test now tolerates it. If a future change wants to close that micro-gap in production too, fold `detail` into the `RemediationStore.open` insert — but that ripples to the spawn incident and the engine and was out of scope here.

## Verification
- **Deterministic reproduction:** injecting a 150ms delay into the test's post-finalize hook (simulating PG lag) made the *old* immediate-read assertions fail with the exact issue error (`expected [] to have a length of 1 but got +0`); the *new* condition-based assertions pass under the same injected delay. This proves the fix targets the race, not luck.
- **Repeated runs:** the self-healing tests passed **25/25** sequential iterations; **32/32** under 4-way concurrent shared-Postgres contention (the deeper `detail` race was caught and fixed during this stress); the full 9-test file passed **12/12** under 4-way concurrency.
- **Gates:** `tsc --noEmit`, `eslint`, `build`, the full unit suite (2699 passed), the integration suite, and the skill/eval colocation check all green.
