# ADR-0039 — Local per-agent git worktree isolation, reaped

**Status:** Accepted · **Issue:** #70 · **Date:** 2026-06-09 · **Depends on:** #25, #50, #51 ·
**Part of:** EPIC #60

## Context
Conductor isolates each local agent in its own git **worktree + branch** and reaps it when the work
is done. Reload reached the *creation* half in #51: when `GIT_WORKSPACE_REPO` is set, the
`GitWorkspaceProvisioner` gives each session a worktree on `agent/<sessionId>` and hands its `cwd` to
the `SessionManager`. But the *teardown* half was missing:

- `GitWorkspaceService.removeWorktree` **existed yet was never called** — every finished or crashed
  session's worktree lived forever.
- There was **no branch cleanup** and **no startup sweep**, so `.reload-worktrees/<id>` dirs and
  `agent/<id>` branches accumulated without bound and survived crashes/restarts.

Meanwhile the cloud path (`SandboxRuntime`, #25) already reaps unconditionally at teardown
(`snapshot()` then `stop()` in a `finally`) — nothing is ever left un-reaped. #70 brings local
execution to that parity.

A complication: the worktree is also the **durable review artifact**. #51 (diff/PR) and #53
(checkpoints/revert) read it *after* the run ends. So reaping on every run's `finally` would regress
those features (and their tests). The correct unit of reaping is therefore **"a session this process
is no longer driving"**, applied by a sweep — not the end of a single run.

## Decision
Add the teardown half to the existing #51 `GitWorkspaceService` and drive it with an opt-in sweep —
**no new dependency, no SessionManager surgery on the run path.**

- **Reaping primitives on `GitWorkspaceService`** (shelled `git` via the injectable argv-only
  `GitRunner`, the #50 no-shell rule):
  - `reapSession(id, { deleteBranch=true })` — idempotent, best-effort teardown of one session:
    `worktree remove --force` → `worktree prune` → `branch -D agent/<id>`. Each step is swallowed on
    failure, so a half-gone crash state converges to fully clean and a reap never throws.
  - `listSessionWorktrees()` — parses `git worktree list --porcelain` and keeps only worktrees whose
    parent dir is the configured `worktreesRoot`, compared by **realpath** (so a `/tmp`↔`/private/tmp`
    symlink can't drop a match). The main checkout and unrelated worktrees are never candidates.
  - `reapOrphans(keep)` — reap every listed session worktree **not** in `keep`, then prune; returns
    the reaped ids.
- **`SessionManager.activeSessionIds`** — the keep-set, backed by the `runs` map (set synchronously in
  `launch`, before the worktree is provisioned), so a sweep can never reap a live run — including one
  in the brief provision→start window.
- **`GitWorktreeReaper.sweep()`** — `reapOrphans(sessionManager.activeSessionIds)`, logged, **never
  throws**. Wired only when a repo is configured (decorated on the app). `index.ts` runs **one sweep
  on boot** — a cold start has nothing live, so every crash leftover is cleaned — and an **opt-in
  periodic sweep** (`GIT_WORKTREE_REAP_INTERVAL_MS`, default `0` = off, mirroring the #17 autonomy
  loop and #55 cloud sweep).

## Why this shape
- **Default behavior unchanged.** No repo configured → no reaper, no sweep (the git/PR routes already
  501). The 367 server-unit + 130 integration tests pass untouched.
- **No run-path surgery.** Reaping lives off to the side (a sweep), so the heavily-tested
  `SessionManager` run path is unchanged — `activeSessionIds` is a read-only getter. Zero blast radius
  on #25, and #51/#53's post-run review of the worktree is preserved.
- **Scoped + injection-safe by construction.** The reaper only ever sees worktrees under
  `worktreesRoot` (realpath-checked); every branch is the deterministic, server-issued `agent/<id>`;
  no client string reaches a git ref or a shell.
- **Crash-correct.** A worktree whose dir was deleted by a crash is still *registered* by git (marked
  prunable), so it is still listed and reaped (worktree+branch); `prune` clears the dangling registration.
- **Hermetic, spend-free tests.** Exercised against a real temp git repo (`git` is on the host) — no
  network, no cloud — plus a real-Postgres/LocalRuntime integration proving concurrent isolation.

## Parity with the cloud (the point of #70)
| | Cloud (`SandboxRuntime`, #25) | Local (#51 + #70) |
|---|---|---|
| Isolation unit | one sandbox per session | one git worktree + `agent/<id>` branch per session |
| Created | `provider.create()` at start | `git worktree add` at provision (#51) |
| Durable state | `snapshot()` at teardown | the worktree itself (read by #51/#53 post-run) |
| Reaped | `stop()` in `finally`, every run | sweep of sessions no longer driven (boot + opt-in timer) |
| Nothing left un-reaped | provider expires dead sandboxes | startup sweep clears crash leftovers |

Local retains the worktree past the run (it is the review artifact and local's analog of the cloud
snapshot); the sweep is local's analog of the provider expiring a dead sandbox.

## Consequences
- **Reaping is liveness-based, not per-run.** A worktree persists while its session is driven and, by
  default, until the next boot sweep / opt-in periodic sweep finds it un-driven. **Per-run auto-reap is
  out of scope** precisely because it would break the #51/#53 post-run review surfaces; a retention
  policy ("reap N hours after terminal", or "reap on explicit session delete") is a documented
  follow-up.
- **A graceful restart reaps terminal sessions' worktrees** (the boot sweep keeps only what the fresh
  process is driving — nothing). The session's git refs are already persisted on the row (#51), so the
  web client still shows branch/sha; only the live diff *patch* is unavailable until the session is
  re-run. Acceptable for parity-with-crash-cleanup; retention is the follow-up above.
- **The periodic sweep is opt-in** (default off) so CI/tests/local dev are unaffected; long-lived
  deployments enable it to bound worktree accumulation.

## Alternatives considered
- **Reap in the SessionManager's run `finally`.** Rejected: breaks #51 diff/PR and #53 revert (both
  read the worktree after the run), and touches the most safety-critical file. The sweep keeps the run
  path untouched.
- **Embed git worktree logic in `LocalRuntime`** (as the issue's first framing suggested). Rejected:
  #51 already put per-session provisioning in the backend-agnostic #58 `WorkspaceProvisioner` seam;
  `LocalRuntime` stays a thin child-process backend, and both Local and Sandbox reach isolation through
  their own provisioning seams. Extending the #51 service is the smaller, parity-preserving change.
- **Track orphans in the DB instead of asking git.** Rejected: git's own `worktree list` is the source
  of truth and survives a crash that never wrote a DB row; a realpath-scoped parse needs no schema.
- **Reap-all on boot unconditionally.** Rejected in favor of keeping `activeSessionIds`, so the same
  code path is safe to run periodically alongside live sessions.
