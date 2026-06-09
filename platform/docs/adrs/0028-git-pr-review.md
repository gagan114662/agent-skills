# ADR-0028 — Git worktree / PR / diff / review workflow

**Status:** Accepted · **Issue:** #51 · **Date:** 2026-06-09

## Context
Conductor's core product surface is the git/PR/review loop: a per-agent worktree, a diff viewer, AI
review with comments that feed back to the agent, Create-PR, and a Checks tab. Reload had a messaging
backend with agent execution (#25 runtime, #50 real harness, #58 per-session workspace) but none of
this surface — an agent edited files in a plain folder that nothing could review. #51 adds the whole
loop while reusing the existing seams (the #58 workspace provisioner for `cwd`, #9 channel
capabilities for auth, the #5 realtime bus for live updates, and the #25 SessionManager for the
round-trip).

## Decision
Introduce git as a **shelled-out service behind seams**, with GitHub behind a provider seam — the same
discipline as the #25 SandboxProvider — so the default deployment and all of CI never touch a real
repo or GitHub.

- **`GitWorkspaceService` (`src/git/`)** shells `git` via an injectable `GitRunner` (argv only, no
  shell — the #50 injection-safety rule). It gives each session an isolated worktree on branch
  `agent/<sessionId>` off a configured base, and computes the cumulative (`base...HEAD`) and turn
  (`HEAD~1..HEAD`) diff. A `GitWorkspaceProvisioner` adapts it to the #58 `WorkspaceProvisioner` seam,
  so the harness's edits land on the session branch. **Opt-in** via `GIT_WORKSPACE_REPO`; with no repo
  configured the #58 file-copy provisioner is used and existing sessions are unchanged.
- **Lazy commit.** The diff/PR routes call `commitTurn` before reading, turning the agent's
  (uncommitted) edits into a reviewable diff **without modifying the heavily-tested SessionManager** —
  zero blast radius on #25.
- **`GitHubProvider` seam (`src/github/`)**: `none` (default — no credentials, every action throws
  `GitHubUnavailableError` → route 501) and `gh` (shells the `gh` CLI, enabled by `GITHUB_PROVIDER=gh`).
  The token is read from the execution environment only — never into a row, log, or response.
- **Persistence** (`0026`): `pull_requests` + `review_comments`, plus `branch/base_branch/head_sha`
  columns on `agent_sessions`. Every row is workspace + channel scoped and every route is IDOR-scoped
  to `:cid`, carrying forward the #3 discipline.
- **Round trip.** Review comments are stored with a `delivered_to_session_id`; a `deliver` action
  formats the undelivered comments into a task and launches a **new** agent session via the
  SessionManager, stamping that session id on the comments. A `fix-ci` action forwards failing-check
  logs the same way. Two new `ServerEvent` variants (`pull_request`, `review_comment`) ride the
  existing `rt:channel:<id>` fan-out so the web surface updates live.
- **Web.** A new `Review` view: a dependency-free `DiffView` (no diff library), a comment composer +
  Deliver button, a Create-PR form, and a Checks tab — one store slice, all under the already-proxied
  `/channels` prefix.

## Why this shape
- **Default behavior unchanged.** Git + GitHub are both opt-in; the 221 server + 95 web tests and the
  #25/#58 sessions are untouched until a repo/provider is configured.
- **Hermetic, spend-free tests.** The git layer is exercised against a real temp repo (`git` is on the
  host); GitHub is a fake/`none` provider — no network, no token, no cloud in CI.
- **Injection-safe by construction.** Every git ref derives from the server-issued `sessionId`; client
  input is data (argv / task env), never a ref or a shell.
- **No SessionManager surgery.** Lazy commit + deterministic worktree paths keep the #25 orchestrator
  and its tests entirely unchanged.

## Consequences
- A live PR/Checks flow needs `GITHUB_PROVIDER=gh`, a `gh`-authenticated environment, and a push
  remote on the repo — an operational prerequisite, not a code dependency; CI stays on `none`.
- A **follow-up session (deliver / fix-ci) runs on a fresh worktree off base** with the full diff +
  comments in its task, rather than continuing the original branch. Branch-continuation for follow-ups
  is a documented follow-up (with per-turn commit granularity from the #50 `stream-json` parse).
- The diff renderer is plain unified diff with line coloring; semantic/syntax-highlighted diff,
  automerge/merge-queue, and Graphite stacks are deferred sub-issues.

## Alternatives considered
- **A git library (`simple-git` / `isomorphic-git`) instead of shelling `git`.** Rejected: the host
  already has `git`, the `spawn` precedent (#25 `LocalRuntime`) is established, and a new runtime dep
  buys nothing for worktree/diff/commit.
- **Wiring commit into the SessionManager (commit each turn during the run).** Rejected for now: it
  would touch the most safety-critical, most-tested file for no functional gain over lazy commit.
- **`@octokit/*` instead of the `gh` CLI.** Rejected: `gh` carries its own auth and keeps the token
  out of the process entirely; octokit would mean managing a token in app config. Revisit if a
  tokenless path is needed.
