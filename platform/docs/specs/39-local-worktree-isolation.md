# Spec 39 — Local per-agent git worktree isolation, reaped (#70)

> Implements [#70](https://github.com/gagan114662/agent-skills/issues/70). Phase 5 — hardening &
> scale. **Depends on #25** (cloud execution runtime) + **#50** (real harness) + **#51** (git
> worktree/diff/PR). Part of EPIC #60. Lifecycle: **DEFINE** artifact (`spec-driven-development`).
> Built the agent_skills way — each stage governed by a skill in `skills/`. No merge without
> approval + video.

## Goal
Bring **local** agent execution to Conductor parity: each local session already runs in its own git
**worktree + branch** (`agent/<sessionId>`, #51), but those worktrees **leak** — nothing ever reaps
them, and a crash/restart leaves orphaned worktrees and dangling `agent/*` branches behind. #70 adds
the missing teardown half: a **reaper** that removes a session's worktree + branch, and a
**startup orphan sweep** that cleans up everything a crashed run left behind — so parallel local
agents are branch-isolated *and* self-cleaning, exactly like Conductor.

## Background
`SandboxRuntime` (#25) reaps its isolation unit unconditionally at teardown (`sandbox.snapshot()`
then `sandbox.stop()` in a `finally`), so nothing is ever left un-reaped in the cloud. The **local**
path reaches isolation through the #58 `WorkspaceProvisioner` seam: when `GIT_WORKSPACE_REPO` is set,
`GitWorkspaceProvisioner` (#51) gives each session a worktree on `agent/<sessionId>` and hands its
`cwd` to the `SessionManager`. But:

- `GitWorkspaceService.removeWorktree` **exists yet is never called** anywhere in the codebase — a
  finished or crashed session's worktree lives forever.
- There is **no branch cleanup** and **no startup sweep**, so `.reload-worktrees/<id>` dirs and
  `agent/<id>` branches accumulate without bound and survive crashes.

The worktree is also the **durable review artifact**: #51 (diff/PR) and #53 (checkpoints/revert) read
it *after* the run ends. So reaping must NOT happen on every run's `finally` (that would regress those
features and their tests). The right unit of reaping is **"a session this process is no longer
driving"**, applied by a sweep — not the end of a single run. This mirrors the cloud model: the
worktree is local's equivalent of the sandbox **snapshot** (the durable state that outlives the run),
and the sweep is local's equivalent of the provider expiring a dead sandbox.

## In scope
- **Reap one session (`reapSession`).** Idempotent, best-effort teardown of a single session's
  isolation: `git worktree remove --force` + `git worktree prune` + (optionally) `git branch -D
  agent/<sessionId>`. Never throws — a partially-gone worktree (crash) still ends fully cleaned.
- **List our worktrees (`listSessionWorktrees`).** Parse `git worktree list --porcelain` and return
  only the session ids whose worktree lives under the configured `worktreesRoot` — so the reaper can
  **never** touch the user's main checkout or an unrelated worktree.
- **Orphan sweep (`reapOrphans(keepSessionIds)`).** Reap every listed session worktree **not** in the
  keep set, then prune. Returns the reaped ids. Driven on **startup** with the set of sessions the
  fresh process is actively driving (empty on a cold boot → every crash leftover is reaped), and
  optionally on a periodic timer for long-lived deployments.
- **`SessionManager.activeSessionIds`.** Expose the in-memory live set so the sweep keeps worktrees of
  sessions this process is still driving — protecting concurrent runs from a racing sweep.
- **Wiring.** Decorate the app with the git workspace + a `GitWorktreeReaper`; `index.ts` runs one
  startup sweep and starts an **opt-in** periodic sweep (`GIT_WORKTREE_REAP_INTERVAL_MS`, default
  `0` = off, mirroring the #17 autonomy loop and #55 cloud sweep). Default behavior unchanged.
- **Parity.** Document the local↔cloud isolation contract: both backends create per-session isolation
  and guarantee no un-reaped unit survives a teardown/restart.

## Out of scope (follow-ups — file as sub-issues)
- **Per-run auto-reap.** Reaping a worktree the instant its run ends would break the #51 review and
  #53 revert surfaces (which read the worktree post-run). Retention policy (e.g. "reap N hours after
  the session goes terminal", or "reap on explicit session delete") is a deliberate follow-up.
- **GUI for worktrees** (client surface — #51/#56).
- **A pruning policy tied to disk pressure / quotas.** The sweep is liveness-based, not size-based.

## Trust & safety boundary (why a sweep, scoped to our root)
- **The reaper only ever touches `worktreesRoot/<sessionId>`.** `listSessionWorktrees` filters
  `git worktree list` to worktrees whose parent dir is the configured `worktreesRoot` (compared by
  realpath, so a `/tmp`↔`/private/tmp` symlink can't cause a false negative). The main repo checkout
  and any unrelated worktree are **never** candidates.
- **Every git ref is server-issued.** Session ids come from the store, branches are the deterministic
  `agent/<sessionId>`; no client string reaches a git ref or a shell — args are an argv array on the
  #51 `GitRunner` (no shell — the #50 rule).
- **The live set guards concurrency.** A sweep keeps the `SessionManager`'s `activeSessionIds`, so it
  can never delete the worktree of a session this process is still driving (no cross-session leakage,
  no interfering with a concurrent run).
- **Best-effort, never fatal.** Reaping is wrapped so a missing dir / locked worktree / already-deleted
  branch never throws — a half-cleaned crash state converges to fully clean, and a sweep failure is
  logged, never crashing startup.

## The git seam — extends `apps/server/src/git/workspace.ts` (#51)
```
GitWorkspaceService(repoRoot, worktreesRoot, baseBranch, runner)            // unchanged ctor
  // existing: branchFor / worktreePathFor / prepare / commitTurn / diff / resetTo / removeWorktree
  listSessionWorktrees()                  -> string[]    // session ids under worktreesRoot (porcelain parse)
  reapSession(sessionId, { deleteBranch=true }) -> void  // remove --force + prune + branch -D; idempotent, never throws
  reapOrphans(keepSessionIds: Iterable<string>) -> string[]  // reap every listed id not in keep; returns reaped ids
```
- `listSessionWorktrees` parses `worktree <path>` lines, keeping those whose `realpath(dirname(path))`
  equals `realpath(worktreesRoot)`; the session id is `basename(path)`.
- `reapSession` is the teardown primitive (generalizes the previously-dead `removeWorktree`): worktree
  remove → prune (cleans a crash where the dir vanished but git still lists it) → branch delete.
- `reapOrphans` = `listSessionWorktrees()` minus `keep`, each through `reapSession`, then a final prune.

## The reaper + wiring — `apps/server/src/git/reaper.ts`, `app.ts`, `index.ts`
```
GitWorktreeReaper(gitWorkspace, sessionManager, logger)
  sweep() -> { reaped: string[] }     // reapOrphans(sessionManager.activeSessionIds); logs; never throws

SessionManager.activeSessionIds: string[]    // in-memory `running` keys (new getter)

app.ts     decorate `gitWorkspace` (already built) + `gitWorktreeReaper` when a repo is configured
index.ts   await reaper.sweep() once on boot; if GIT_WORKTREE_REAP_INTERVAL_MS>0, setInterval(sweep).unref()
env.ts     git: { reapIntervalMs }   // GIT_WORKTREE_REAP_INTERVAL_MS, default 0 = off
```
- **Opt-in, default unchanged.** No repo configured → no reaper, no sweep (the git/PR routes already
  501). Repo configured → one startup sweep (cheap, idempotent), periodic only when explicitly enabled.

## Testing strategy
- **Unit (hermetic, no DB — `pnpm test`), against a REAL temp git repo** (`git` is on the host, no
  network), extending `git/workspace.test.ts` + a new `git/reaper.test.ts`:
  - `reapSession` removes a session's worktree dir **and** its `agent/<id>` branch; a second call is a
    no-op (idempotent); reaping session A leaves session B's worktree + branch intact (**isolation**).
  - `listSessionWorktrees` returns only ids under `worktreesRoot` (never the main checkout).
  - `reapOrphans([B])` removes A's worktree+branch and keeps B's — the **keep set** is honored.
  - **Crash/restart:** prepare two sessions, then `rm -rf` one worktree dir behind git's back (crash
    sim) and **construct a fresh `GitWorkspaceService`** (new process) → `reapOrphans([])` leaves
    `git worktree list` with only the main checkout, no `agent/*` branches → **no orphans**.
  - `GitWorktreeReaper.sweep()` keeps `sessionManager.activeSessionIds` and reaps the rest (fake
    SessionManager exposing a live set + the real temp-repo service).
  - `SessionManager.activeSessionIds` reflects the in-flight set (extends `session-workspace.test.ts`).
- **Integration (real Postgres, `LocalRuntime`, temp git repo — `pnpm test:integration`):** configure
  the git provisioner with a temp repo; **launch two sessions concurrently**, each harness writing a
  distinct file; join both → each file lands on **its own** `agent/<id>` branch only, the two
  worktrees are distinct (**concurrent isolation**, acceptance #1/#3). Then simulate a crash leftover
  (a prepared-but-unjoined worktree) and run the reaper → the orphan is gone, the live sessions'
  worktrees remain (acceptance #2).

## Boundaries
- **Always:** scope every reap to `worktreesRoot/<sessionId>` (realpath-checked); derive refs from the
  server-issued session id; pass git args as argv (no shell); keep the reaper best-effort (never throw,
  never crash startup); keep the periodic sweep opt-in (default off); write the failing test first;
  attach the demo video.
- **Ask first:** enabling per-run auto-reap by default; reaping worktrees of sessions that are still
  terminal-but-reviewable (a retention policy); turning the periodic sweep on by default.
- **Never:** touch a worktree outside `worktreesRoot`; delete a branch that isn't `agent/<sessionId>`;
  let a client string reach a git ref or a shell; reap a session in `activeSessionIds`; merge without
  approval + video.

## Success criteria
1. **Two local sessions run concurrently** on separate worktrees/branches without interfering; each
   session's edits land on **its own branch only** (integration: concurrent launch + per-branch diff).
2. **`reapSession` removes the worktree + branch**; idempotent; isolated from other sessions (unit).
3. **No orphans after a crash/restart**: a fresh-process `reapOrphans([])` leaves only the main
   checkout and no `agent/*` branches (unit, crash sim).
4. The sweep **keeps `activeSessionIds`** so a concurrent live run is never reaped (unit).
5. `pnpm -C platform typecheck && lint && test && build` green; integration green. Default behavior
   (no repo configured) unchanged.
6. ADR-0039 + this spec + demo `docs/demos/39-local-worktree-isolation.mp4`; PR links #70; **not**
   merged.

## Plan (atomic)
1. `git/workspace.ts` — `listSessionWorktrees`, `reapSession`, `reapOrphans` (+ tests) — *slice 1*.
2. `runtime/manager.ts` — `activeSessionIds` getter (+ test) — *slice 2*.
3. `git/reaper.ts` — `GitWorktreeReaper.sweep()` (+ test) — *slice 3*.
4. `env.ts` + `app.ts` decoration + `index.ts` startup + opt-in periodic sweep — *slice 4*.
5. Integration: concurrent isolation + orphan reap (real PG, temp repo) — *slice 5*.
6. ADR-0039 + demo + PR — *ship*.

> Approach: DEFINE → PLAN → BUILD with TDD → VERIFY → REVIEW (code + security) → ship → demo → PR;
> reviewed and merged by @gagan114662 on the video. No merge without approval.
