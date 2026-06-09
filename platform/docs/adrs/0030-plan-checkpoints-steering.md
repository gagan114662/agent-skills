# ADR-0030 — Plan mode, Checkpoints & Steering

**Status:** Accepted · **Issue:** #53 · **Date:** 2026-06-09

## Context
Conductor's trust loop has three controls Reload lacked: **plan mode** (an agent proposes a plan and
work blocks until a human approves / approves-with-feedback / rejects), **checkpoints** (revert a chat
to a prior turn, wiping both history **and** file changes), and **steering** (interrupt and redirect a
running agent). Reload had server-owned agent execution (#25), the real Claude Code harness (#50), and
per-session git worktrees with lazy `commitTurn` + turn diffs (#51) — and approval gates for
**sensitive actions** (#13), but nothing for **plan review**, **rollback**, or **live steering**. These
are what make a long-running autonomous agent reviewable instead of a black box.

## Decision
Add the three controls as **orchestration around the existing seams**, not surgery inside them —
the same discipline #51 used (lazy commit, deterministic worktrees, zero `SessionManager` rewrites).

- **A `turns/` module (`src/turns/`) with pure cores + one orchestrator.** `plan.ts` (the plan state
  machine, execution-task composition, plan parsing, decision validation) and `checkpoint.ts` (the
  revert-target selection) are **pure and unit-tested**. `TurnController` is the orchestrator; its
  dependencies (a `SessionManager`-shaped launcher, a `GitWorkspaceService`-shaped git, the repos) are
  **injected**, so the whole flow is unit-testable with fakes — no DB, no Postgres, no model spend.
- **Plan mode = a gate before a second launch.** `propose` launches a **plan-mode** session
  (`AGENT_PLAN_MODE=1`, threaded via the existing #59 `harnessEnv` seam) that proposes a plan and does
  **no work**; `decide(approve|approve_with_feedback)` then launches the **execution** session with the
  plan (+ feedback) composed into its `AGENT_TASK`. "Work blocks until approval" is literal: no
  execution session exists until a human decides. The decision is recorded in `plan_proposals`.
- **A checkpoint = a commit + a conversation cursor; revert restores both.** A **turn** is a commit on
  the session's #51 branch. `checkpoint` captures `{ head_sha = commitTurn(...), cursor_message_id =
  the channel's latest message id }` into a `session_turns` ledger. `revert` resets the worktree to the
  checkpoint **before** the target turn (`git reset --hard`, new `GitWorkspaceService.resetTo`) **and**
  soft-deletes every channel message after that turn's cursor (new `messages.softDeleteMessagesAfter`,
  reusing the #4 `deleted_at` column). The files and the chat return together.
- **Steering = an additive, default-off runtime seam.** `SessionManager.steer(sessionId, text)` mirrors
  `cancel`: it finds the in-flight session and delivers the guidance to the live process via an
  **optional** `RunningSession.steer?` (like `sandboxId?`). `LocalRuntime` implements it by writing to
  the child's **stdin** (opened as a pipe); `SandboxRuntime`/fakes may omit it. The steer route also
  **posts** the guidance into the channel as the requester, so the redirect is recorded and visible
  even where the harness can't yet consume stdin mid-run.
- **Persistence** (`0053`): `plan_proposals` + `session_turns`, every row workspace + channel scoped,
  every route IDOR-scoped to `:cid` — carrying forward the #3/#19 discipline.

## Why this shape
- **No SessionManager surgery.** Checkpoint/revert reuse #51's `commitTurn` + deterministic worktree
  paths; plan mode is two ordinary `launch` calls with a gate between; only `steer` adds a method to
  the manager, and it is additive and default-off. The heavily-tested #25 orchestrator and its tests
  are unchanged.
- **Hermetic, spend-free tests.** The plan/revert logic is pure; the controller runs on fakes; the git
  half runs against a real temp repo (`git` is on the host); the integration path uses LocalRuntime +
  a steerable **demo** harness — no model, no network, no cloud in CI.
- **Injection-safe by construction.** Plan text, feedback, and steering guidance reach the agent only
  as `AGENT_TASK` (double-quoted env, #50) or stdin — never argv; every git ref and worktree path
  derives from the server-issued session id; `restoreSha` is always a stored sha or the base ref, never
  a client string.
- **Default behavior unchanged.** The new seams are additive; with no plan/steer/revert call the
  #25/#50/#51 paths are byte-for-byte today's. Checkpoint/revert routes 501 without a configured git
  repo (like #51's diff/PR), so the default deployment and CI need no repo.

## Consequences
- **Mid-run steering is a no-op for `claude -p` today.** Print mode reads its prompt from argv, not
  stdin, so the stdin seam doesn't redirect the real harness yet — but the guidance is still persisted
  into the channel (the human-visible redirect) and the seam is in place. Wiring steering into Claude
  Code's resumable-session/control protocol (`--resume`) is a documented follow-up.
- **A "turn" is scoped to one session's worktree.** Checkpoint/revert operate within a single session
  branch (the #51 model). Threading one worktree across many sessions in a channel (a channel-level
  flow) is a follow-up; cross-session revert is therefore out of scope here.
- **Plan hand-off across agents is deferred** (out of scope in #53): the execution runs as the **same**
  agent. Approve-and-hand-off ties into A2A (#12) / subagents (#59) / autonomy (#17).
- **Migration ordering.** `0053` follows the issue-number convention (cf. `0059` for #59). It sorts
  before `0059`, so on a DB that already has `0059` applied, `db:rollback` reverts `0059` first — a
  pre-existing property of the filename-ordered runner, not specific to this change; `db:reset`
  re-applies cleanly.

## Alternatives considered
- **A multi-turn conversation loop inside `SessionManager` (commit + checkpoint each model turn).**
  Rejected: it would rewrite the most safety-critical, most-tested file for no functional gain over
  capturing checkpoints around it (the #51 lesson). Auto-checkpoint from the `stream-json` parse is a
  follow-up.
- **Hard-deleting messages on revert.** Rejected: a soft delete (`deleted_at`) is recoverable and
  audit-safe, and the list queries already exclude soft-deleted rows, so the chat "returns" without
  destroying history.
- **Steering via a polled file in the worktree instead of stdin.** Rejected as the primary path: stdin
  is the honest "inject into the live process" seam and is addressable for any runtime; the file
  approach only works for git-worktree sessions and is more indirect. (The persisted channel message
  already covers the non-stdin harnesses.)
- **A new approval table vs. reusing #13 approvals for plans.** Rejected reuse: #13 gates *actions*
  (`chat.post_message` / `external.send`) with a policy engine; a plan decision is a different shape
  (propose → approve/approve-with-feedback/reject with a free-text note and a resulting execution
  session), so a focused `plan_proposals` table is clearer than overloading the action schema.
