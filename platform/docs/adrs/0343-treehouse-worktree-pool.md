# ADR-0343: treehouse warm worktree pool — evaluation + opt-in acquire path

- **Status:** Accepted (slice 1: evaluation + opt-in integration shipped in PR for #343). Fleet-wide
  default-ON adoption is **deferred** — see Go/No-Go.
- **Date:** 2026-06-18
- **Context issue:** [#343](https://github.com/gagan114662/agent-skills/issues/343) — adopt
  [kunchenguid/treehouse](https://github.com/kunchenguid/treehouse) (Go CLI, MIT) to give the agent/Conductor
  fleet warm, reusable, conflict-free git worktrees instead of a fresh per-session repo copy.
- **Builds on:** [ADR-0200](0200-premortem-panel.md) (real measured receipts, never assume isolation,
  no irreversible auto-destroy), [ADR-0319](0319-honest-session-disposition.md) /
  `agent-registry` (the DEFAULT-OFF, owner-workspace-first config-block rollout this mirrors), the #51
  `GitWorkspaceService` and #70 `GitWorktreeReaper` (the existing per-session worktree + reaper this is
  additive to).

## Context

Every fleet/Conductor session today provisions a **fresh** working dir. With a git repo configured (#51)
that is `git worktree add -b agent/<sessionId>`; a fresh worktree contains only tracked files, so the
session must **re-materialize `node_modules` + build cache before it can do anything** — and that
materialization is the dominant spin-up cost. treehouse's model: keep a per-repo **pool** of reusable
worktrees; hand a session a clean-but-warm one (tracked files reset to base, gitignored deps/cache
intact); detect in-use worktrees; detached HEAD to avoid branch-name clashes; no daemon.

The premortem (#200) demands this be justified with **real measured numbers**, that isolation be
**verified, not assumed**, and that no path **auto-destroys uncommitted work**.

## Evaluation — measured receipts (#200 §2)

`platform/scripts/worktree-pool-benchmark.mjs` builds a throwaway git repo (2176 tracked files ≈ this
repo, plus a 6000-file gitignored `node_modules`/build-cache fixture) and times both spin-up paths with
**real git**, fully offline, 5 iterations. Receipt: `platform/docs/evidence/worktree-pool-benchmark.json`.

| Path | What it does | Median |
|------|--------------|--------|
| **COLD** (today) | `git worktree add` + materialize deps (a fresh checkout has none) | **1522 ms** |
| **WARM** (pool) | `git reset --hard` + `git clean -fd` (no `-x`) a pooled worktree | **60 ms** |

- **Speedup: ~25.4× median** (saves ~1462 ms/session). git 2.39.5, darwin/arm64.
- **Cache reuse verified:** all 6000 dep files were byte-identical after **every** warm reuse — the reset
  never touched gitignored deps. The benchmark **fails** if a single reuse loses them.
- The cold cost is a **conservative lower bound**: deps are modeled as a file-count fixture, but a real
  package install also resolves/downloads/links. As an additional real data point, `pnpm install
  --frozen-lockfile` with a warm content-addressed store took **~3.2 s** to materialize this repo's
  `node_modules` in a fresh worktree — work the pool path skips entirely (0 reinstall on reuse).

**Conclusion:** the warm-reuse hypothesis holds with real numbers. The win scales with dep/cache size, so
on a heavy worktree it is far larger than 25×.

## Decision

Ship **slice 1: evaluation + an opt-in acquire path**, additive and default-OFF. We do **not** install the
treehouse binary (its installer is `curl | sh`) on the owner's machine, shared infra, or CI — that stays
owner-gated. Instead the platform implements the same pool semantics over plain `git`, so the opt-in path
works with zero new third-party dependency, and the `treehouse` CLI workflow is documented for the owner.

### 1. Pure decision core — `worktree-pool/pool.ts`

No git, no I/O. `decideAcquire` / `decideRelease` / `decideDestroy` / `isInUse` / `reapableLeases` encode
the policy and the two #200 invariants, exhaustively unit-tested:

- **Conflict-free (#200 §3):** a leased slot is never selected — two concurrent acquires get distinct
  slots or `exhausted`, never the same worktree. Verified against real concurrent acquires in the service
  test (`Promise.all` of N → N distinct paths).
- **Reversibility (#200 §4):** `decideDestroy` **refuses a dirty worktree without `force`** — destroying
  uncommitted work is irreversible, so it is never automatic.

### 2. Executor — `worktree-pool/service.ts`

Materializes the decisions against real git (argv, no shell — the #50 rule). `acquire` reuses a warm slot
/ resets a dirty one / grows up to `size` / throws `WorktreePoolExhaustedError` at cap. `release` resets
tracked files to base (`git reset --hard` + `git clean -fd`, **no `-x`** so gitignored deps survive).
`releaseInactive` is the #70 keep-set reaper, pool edition — it returns a crashed session's slot but
never a live concurrent one. `discover` re-adopts on-disk pool worktrees after a restart (realpath compare
so a `/tmp`↔`/private/tmp` symlink can't drop a match). Pool worktrees live under
`<repo>/.reload-worktree-pool` — a **different** root from the #51 `.reload-worktrees`, so the existing
reaper can never see or destroy a pool slot.

### 3. Opt-in provisioner — `worktree-pool/provisioner.ts`

`PooledWorktreeProvisioner` decorates the existing `WorkspaceProvisioner` seam: when the pool is enabled
for the session's workspace it leases a warm worktree, else (and on any pool error/exhaustion) it
delegates to the existing provisioner. `maybePooledWorktreeProvisioner` returns the fallback **unchanged**
unless a git repo is configured AND the pool is enabled at the server level — so a deployment that sets
nothing gets exactly today's provisioner. Wired once at the composition root
(`runtime/default.ts createDefaultSessionManager`).

### 4. Config block — `worktreePool` (default OFF, owner-workspace-first)

`{ enabled, ownerWorkspaceOnly, ownerWorkspaceId, size }`, resolved by `worktree-pool/caps.ts` with hard
defaults (`enabled:false`, `ownerWorkspaceOnly:true`, `size:4`). Mirrors `agentCollaboration`/`venture`:
enabling without naming `ownerWorkspaceId` pools **nobody**. Env override:
`RELOAD_WORKTREE_POOL_ENABLED` / `_OWNER_WORKSPACE_ID` / `_SIZE` (owner marker reuses the #258
`RELOAD_MARKETING_OWNER_WORKSPACE_ID`).

### 5. Repo config + docs

[`treehouse.toml`](../../../treehouse.toml) (pool_size, base) at the repo root, and the
`treehouse / get / status / return / destroy` fleet workflow documented in
[AGENTS.md](../../../AGENTS.md#warm-worktree-pool-treehouse).

## Go / No-Go on fleet-wide adoption

**GO — conditionally, owner-first.** The mechanism is proven (25× faster, deps verifiably preserved,
isolation verified under real concurrency, irreversibility gated). It ships **default-OFF, owner-workspace
first** so the owner can dogfood it on their own workspace before any tenant is affected, exactly per #200
§4/§5 (bounded blast radius, owner attention budgeted).

**NOT YET fleet-wide default-ON.** Deferred until the owner-workspace soak confirms in production:
1. session-end **release** is wired into the runtime lifecycle (slice 1 ships `release`/`releaseInactive`
   + the reaper primitive and the acquire path; auto-release-on-finalize across the fleet is the next
   slice) so the pool actually recycles rather than growing to `size` then falling back;
2. the pooled-worktree diff/commit/PR flow (#51) is exercised end-to-end on a real PR (the lease creates
   the `agent/<sessionId>` branch so it should be drop-in, but this needs a production-grounded check, #200
   §3);
3. the treehouse binary install decision (owner-gated `curl | sh`) — adopt the real CLI vs. keep the
   in-repo git implementation — made with the owner.

Until then the in-repo path remains the supported one and stays OFF by default.

## Consequences

- **Additive, zero default change:** flag off ⇒ `maybePooledWorktreeProvisioner` returns the existing
  provisioner; existing #51/#70 tests and behavior are untouched.
- **No new third-party dependency** for the opt-in path; the treehouse binary stays owner-gated.
- New surface is pure-first and fully unit-tested (real temp-git service tests + pure decision tests +
  decorator gating tests). No migration (config-resolved, in-memory lease state, worktrees discovered
  from git).
