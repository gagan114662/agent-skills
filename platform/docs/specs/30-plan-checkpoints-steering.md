# Spec: Reload Platform — Plan mode, Checkpoints & Steering (Issue #53)

> Implements [#53](https://github.com/gagan114662/agent-skills/issues/53). Feature phase 4 — Real
> execution & Conductor parity.
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Built the agent_skills way — every stage
> is governed by a skill in `skills/`. Builds on [#50/#27](27-real-agent-harness.md) (the real Claude
> Code harness behind a config flag), [#25](25-cloud-execution.md) (`AgentRuntime` / `SessionManager`
> / `AgentJob`), [#51/#28](28-git-pr-review.md) (the per-session git worktree + lazy `commitTurn` +
> turn diff), [#13](13-approval-gates.md) (the approval pattern), [#9](09-registry-rbac.md) (the
> read<write<propagate capability ladder), [#5](05-realtime-messaging.md) (the realtime bus), and
> [#4](04-channels-dms.md) (channel messages + soft-delete).

## Objective
**What:** Add three Conductor-parity controls to the session lifecycle:
1. **Plan mode** — an agent **proposes a plan** and **work blocks until a human decides**:
   **approve**, **approve-with-feedback** (approve but steer the execution with a note), or **reject**.
2. **Per-turn checkpoints** — every **turn** (a commit of the agent's work on its session branch) is
   captured as a **checkpoint** = `{ working-tree snapshot, conversation cursor }`, and any prior turn
   can be **reverted** — restoring **both** the files (git) **and** the conversation (messages).
3. **Steering** — a human **injects guidance into a live, in-flight session**, redirecting the running
   agent without cancelling and relaunching it.

**Why:** Conductor's loop has plan mode (propose → approve / **approve-with-feedback** / hand off),
checkpoints (revert a chat to any prior turn, wiping history **and** changes), and steering (interrupt
and redirect a running agent). Reload has agent execution (#25/#50) and approval gates for **sensitive
actions** (#13) — but nothing for **plan review**, **rollback**, or **live steering**. These are the
controls that make a long-running agent *trustworthy*: you review its plan before it works, you can
undo a turn cleanly, and you can course-correct mid-run.

**Who:** Any member who can act in a channel (a human or an agent with the right #9 capability). A
plan is proposed by an agent and decided by a member with `write`; a checkpoint is reverted and a
session is steered by a member with `write` on the channel.

### Acceptance criteria (from #53)
1. **An agent proposes a plan; work blocks until approval.** A plan-mode session emits a proposed
   plan and **does no work**; no execution session launches until a human **approves** (optionally
   **with feedback**) or **rejects** it. Approve-with-feedback threads the note into the execution
   task; reject launches nothing.
2. **Reverting a turn restores both conversation and files.** Reverting to before turn *T* resets the
   session worktree to the checkpoint captured before *T* (`git reset --hard`) **and** soft-deletes
   every channel message produced from *T* onward — the chat and the working tree return together.
3. **A steering message redirects an in-flight agent.** A guidance string sent to a running session is
   delivered to the live agent process (and recorded in the channel), redirecting it without a
   cancel/relaunch.
4. `pnpm -C platform typecheck && lint && test && build` green; integration green.
5. ADR-0030 + this spec + demo script `scripts/demos/30-plan-checkpoints-steering.sh` (the runnable
   proof; recorded video pending); PR links #53; **not**
   merged (approved by @gagan114662 on the video).

### In scope
- **A `turns/` module** in `apps/server/src/turns/` — pure cores (no I/O, unit-tested) + one
  orchestrator:
  - `plan.ts` — **pure** plan logic:
    - `decidePlan(current, decision)` — the plan state machine. Only a `proposed` plan may be decided;
      `approve` → `approved`, `approve_with_feedback` → `approved_with_feedback`, `reject` →
      `rejected`. Returns `{ status, proceed }` (`proceed` is true iff an execution turn should
      launch). Deciding an already-decided plan throws.
    - `composeExecutionTask(originalTask, planText, decision, feedback?)` — builds the execution
      session's task **as data**: the original task + the approved plan, plus the feedback note when
      `approve_with_feedback`. Never argv (threaded via `AGENT_TASK`, see #50). `reject` ⇒ throws (no
      task).
    - `parsePlanProposal(output)` — extracts the proposed plan from harness output: the block between
      `<<<PLAN>>>` and `<<<END_PLAN>>>` markers, trimmed; returns `null` when absent (so the route can
      400 a plan-mode run that produced no plan).
    - `validateDecisionInput(decision, feedback?)` — bounded, non-secret: `decision` ∈ the three
      verbs; `feedback` required + non-empty for `approve_with_feedback`, forbidden otherwise, length
      ≤ 4000. Rejects with a clear, content-free error.
  - `checkpoint.ts` — **pure** revert selection:
    - `planRevert(turns, targetTurnId)` — given the **ordered** turns of a session and a target turn,
      returns the **revert plan**: `{ restoreSha, truncateAfterMessageId, discardedTurnIds }`.
      Reverting *T* restores the state **before** *T*: `restoreSha` = the previous turn's `headSha`
      (or the session **base** sentinel when *T* is the first turn); `truncateAfterMessageId` = the
      previous turn's `cursorMessageId` (or the session's launch cursor for the first turn);
      `discardedTurnIds` = *T* and every turn after it. Unknown/empty ⇒ throws. Idempotent inputs
      (already-reverted turns excluded) are handled by the caller.
  - `controller.ts` — `TurnController` — the orchestrator. **Pure deps injected** (a `launcher`
    shaped like `SessionManager`, a `git` shaped like `GitWorkspaceService`, the repos, an id/clock),
    so it is unit-testable without a DB, Postgres, or a real model:
    - `propose({ channelId, agentMemberId, task, by })` → launches a **plan-mode** session
      (`harnessEnv: { AGENT_PLAN_MODE: "1" }`), `join`s it, `parsePlanProposal`s its result, and
      persists a `plan_proposals` row (`proposed`). **Launches no execution.** Returns the proposal.
    - `decide({ proposalId, decision, feedback, by })` → `validateDecisionInput` + `decidePlan`; on
      `proceed`, `composeExecutionTask` and `launcher.launch(...)` the **execution** session, recording
      a `session_turns` row linked to the proposal; persists the decision either way. Returns
      `{ status, executionSessionId? }`.
    - `checkpoint({ sessionId, channelId })` → `git.commitTurn(sessionId, …)` → `headSha` (null when
      nothing changed); inserts a `session_turns` row with `headSha` + `cursorMessageId` (the channel's
      latest message id now) at the next `idx`. The **checkpoint capture**.
    - `revert({ sessionId, turnId, by })` → `planRevert` over the session's live turns →
      `git.resetTo(sessionId, restoreSha)` (files) + `messages.softDeleteAfter(channelId,
      truncateAfterMessageId)` (conversation) + marks the discarded turns `reverted`. Returns the
      restored `{ restoreSha, deletedMessageCount, discardedTurnIds }`.
- **Seams (additive, default-OFF — existing #25/#50/#51 behavior byte-for-byte unchanged):**
  - **`SessionManager.steer(sessionId, text): Promise<boolean>`** (`runtime/manager.ts`) — mirrors
    `cancel`: looks up the in-flight session and, when the runtime supports it, delivers the guidance
    to the live process; returns whether it was delivered (false for an unknown/terminal session or a
    runtime without steering). No steer call ⇒ no behavior change.
  - **`RunningSession.steer?(text): Promise<void>`** (`runtime/types.ts`) — **optional**, like
    `sandboxId?`. `LocalRuntime` implements it by writing `text + "\n"` to the child's **stdin**
    (opened as a pipe instead of `ignore`); `SandboxRuntime` and test fakes may omit it. Opening
    stdin as a pipe is harmless for `claude -p` (prompt is argv, not stdin) and the `demo` harness
    (ignores stdin) — only the **steerable** demo path reads it.
  - **`GitWorkspaceService.resetTo(sessionId, sha)`** (`git/workspace.ts`) — `git reset --hard <sha>`
    in the session worktree (sha derives from a stored checkpoint or the server-issued base ref; argv
    only, no shell — the #50 rule). Used by revert.
  - **`messages` repo** (`db/repositories/messages.ts`) — `latestMessageId(channelId)` (the
    conversation cursor) + `softDeleteMessagesAfter(channelId, afterMessageId)` (soft-delete every
    non-deleted message created **after** the cursor message, by `created_at`; returns the count). The
    revert's conversation half. Reuses the existing `deleted_at` soft-delete column (#4).
- **Persistence** (`drizzle/0053_plan_checkpoints_steering.sql` + `.down.sql`, copying the #25/#59
  schema+migration+repo trio):
  - `plan_proposals` — `id`, `workspace_id` (FK → workspaces, cascade), `channel_id` (FK → channels,
    cascade), `agent_member_id` (FK → members, cascade), `plan_session_id` (FK → agent_sessions, set
    null — the plan-mode run that proposed it), `original_task`, `plan_text`, `status`
    (`proposed`|`approved`|`approved_with_feedback`|`rejected`, CHECK), `feedback` (nullable),
    `execution_session_id` (FK → agent_sessions, set null — the launched execution), `created_by_member_id`
    (FK → members, set null), `decided_by_member_id` (FK → members, set null), `created_at`,
    `decided_at`. Indexed by channel.
  - `session_turns` — the **checkpoint ledger**: `id`, `workspace_id` (FK, cascade), `channel_id`
    (FK, cascade), `session_id` (FK → agent_sessions, cascade), `idx int` (0-based order within the
    session), `kind` (`work`, CHECK — `plan` lives in `plan_proposals`; reserved for future),
    `head_sha` (nullable — the worktree snapshot), `cursor_message_id` (FK → messages, set null — the
    conversation cursor at capture), `plan_proposal_id` (FK → plan_proposals, set null), `reverted_at`
    (nullable — set when a revert discards it), `created_at`. Unique `(session_id, idx)`; indexed by
    session.
  - Repos `db/repositories/plan-proposals.ts` + `db/repositories/session-turns.ts`.
- **Routes** — `routes/turns.ts`, gated by #9 channel capabilities + the #19 tenant guard, IDOR-scoped
  to `:cid` exactly like #25/#51:
  - `POST /channels/:cid/plans` — propose (`write`; body `{ agentMemberId, task }`; target must be an
    in-workspace agent). 202 `{ proposalId, status, planText }`.
  - `GET  /channels/:cid/plans` — list the channel's proposals (`read`).
  - `POST /channels/:cid/plans/:id/decide` — decide (`write`; body `{ decision, feedback? }`). Returns
    `{ status, executionSessionId? }`.
  - `POST /channels/:cid/agent-sessions/:id/checkpoint` — capture a checkpoint/turn (`write`). 201 the
    turn.
  - `GET  /channels/:cid/agent-sessions/:id/turns` — list the session's turns / checkpoints (`read`).
  - `POST /channels/:cid/agent-sessions/:id/turns/:turnId/revert` — revert to before that turn
    (`write`). Returns the restored state.
  - `POST /channels/:cid/agent-sessions/:id/steer` — steer (`write`; body `{ guidance }`). Posts the
    guidance into the session thread (as the requester, like #13 `chat.post_message`) and calls
    `sessionManager.steer`; returns `{ delivered }`.
- **Steerable demo harness** — `scripts/agent-harness-plan-demo.sh`: when `AGENT_PLAN_MODE=1` it prints
  a `<<<PLAN>>> … <<<END_PLAN>>>` block and exits (proposes, does no work); otherwise it does "work"
  and, if steering is enabled, tails stdin and echoes `steer: <guidance>` so the integration test can
  observe a live redirect. Dev/CI only — no model spend; the real `claude-code` harness is the
  drop-in (see Out of scope for the print-mode steering nuance).
- **Wiring** — `app.ts`: construct a `TurnController` over the shared `SessionManager` + the opt-in
  `GitWorkspaceService` (#51) and register `turns.ts`. When no git repo is configured (`GIT_WORKSPACE_REPO`
  unset), checkpoint/revert routes return **501** (like #51's diff/PR), so default deployments and CI
  are unaffected. Plan + steer need no git.
- **Docs/examples** — ADR-0030, this spec, the demo script + recording, a README section, `.env.example`
  note for the steerable demo harness.

### Out of scope (deferred / documented-not-automated)
- **Plan hand-off across agents** (explicitly out of scope in #53) — approve-and-hand-off ties into
  A2A (#12) / subagents (#59) / autonomy (#17). This issue ships propose → approve / approve-with-feedback
  / reject and runs the execution as the **same** agent.
- **Real-`claude-code` mid-run steering.** `claude -p` print mode takes its prompt from argv and does
  not consume stdin mid-run, so the stdin seam is a no-op for it today; the steer message is still
  **persisted** into the channel (the human-visible redirect) and the seam is in place. Wiring steering
  into the harness's resumable session protocol (Claude Code `--resume` / a control channel) is a
  documented follow-up — the deterministic, gated `steer` path the harness would call ships here.
- **Cross-session / shared-worktree turns.** A "turn" is a commit on **one** session's branch (the #51
  model); checkpoint/revert operate within that session's worktree. A channel-level flow that threads
  one worktree across many sessions is a follow-up.
- **A web UI** for plan review / checkpoint timeline / steering composer — follow-up under #18 (the web
  client will call these routes; the composer queue #54 already models the client side of steering).
  The demo drives the REST API.
- **Auto-checkpoint on every harness turn.** Checkpoints are captured by an explicit `checkpoint` call
  (route / controller), mirroring #51's lazy commit — zero SessionManager surgery. Parsing the #50
  `stream-json` to auto-commit each model turn is a documented follow-up.

## The model
```
plan_proposals                          // the plan-review workflow
  id, workspaceId, channelId, agentMemberId
  planSessionId        // the AGENT_PLAN_MODE=1 run that proposed it
  originalTask, planText
  status               // proposed -> approved | approved_with_feedback | rejected
  feedback?            // the approve-with-feedback note (threaded into the execution task)
  executionSessionId?  // the session launched on approval (null until/unless approved)
  createdByMemberId?, decidedByMemberId?, createdAt, decidedAt?

session_turns                           // the checkpoint ledger (one row per captured turn)
  id, workspaceId, channelId, sessionId
  idx                  // 0-based order within the session
  kind = 'work'
  headSha?             // git snapshot (commitTurn) — the files half of the checkpoint
  cursorMessageId?     // channel's latest message id at capture — the conversation half
  planProposalId?      // set when this work turn came from an approved plan
  revertedAt?          // set when a revert discards this turn
  createdAt

propose(channelId, agentMemberId, task, by)
  1. requireChannelCapability(by, channelId, "write")               // may act here
  2. session = launcher.launch({ …, task, harnessEnv:{ AGENT_PLAN_MODE:"1" } })  // plan-mode run
  3. await launcher.join(session.id); planText = parsePlanProposal(result)        // propose only
  4. insert plan_proposals(proposed)  -> { proposalId, planText }   // NO execution launched

decide(proposalId, decision, feedback?, by)
  1. requireChannelCapability(by, channelId, "write")
  2. validateDecisionInput(decision, feedback); { status, proceed } = decidePlan(proposed, decision)
  3. if proceed: task = composeExecutionTask(originalTask, planText, decision, feedback)
                 exec = launcher.launch({ …, task }); record session_turns(planProposalId)
  4. update plan_proposals(status, feedback, decidedBy, executionSessionId?)  -> { status, executionSessionId? }

checkpoint(sessionId, channelId)                                    // capture a turn
  headSha = git.commitTurn(sessionId, "turn N"); cursor = messages.latestMessageId(channelId)
  insert session_turns(idx=next, headSha, cursorMessageId)          -> turn

revert(sessionId, turnId, by)
  1. requireChannelCapability(by, channelId, "write")
  2. { restoreSha, truncateAfterMessageId, discardedTurnIds } = planRevert(turns, turnId)
  3. git.resetTo(sessionId, restoreSha)                             // files
     n = messages.softDeleteMessagesAfter(channelId, truncateAfterMessageId)   // conversation
     mark discardedTurnIds reverted                                 -> { restoreSha, deletedMessageCount:n }

steer(sessionId, guidance, by)
  1. requireChannelCapability(by, channelId, "write")
  2. postMessage(channelId, by, guidance)                          // recorded redirect (as requester)
  3. delivered = sessionManager.steer(sessionId, guidance)         // live injection            -> { delivered }
```

## Security
The trust boundary reuses the #9 capability ladder and the #25 injection-safety discipline — no new
authority is invented:
- **Channel capability gates every action.** Propose / decide / checkpoint / revert / steer all require
  `write` on the target channel (list is `read`); reverting and steering are real side effects on the
  conversation + a live process, so they are write-gated. Every route is IDOR-scoped to `:cid` and
  tenant-scoped (#3/#19): a session/plan/turn id from another channel or workspace is a 404, never
  actionable.
- **Plan/feedback/guidance are data, never argv.** The plan text, the feedback note, and the steering
  guidance reach the agent **only** via `AGENT_TASK` (execution task) or the runtime's **stdin**
  (steering) — double-quoted/streamed exactly like #50, so a hostile plan or guidance string cannot
  break out into the command line. `AGENT_PLAN_MODE` is a fixed `"1"`.
- **Steering targets a live, owned session.** `steer` only delivers to a session the manager is
  actively driving (`running` map); a terminal/unknown session returns `delivered:false`. The session
  id is server-issued; stdin is the session's own process. No cross-session injection.
- **Revert is bounded by server-issued refs.** `restoreSha` comes from a **stored** `head_sha` (a sha
  the agent itself committed) or the server-issued base ref — never a client string; `resetTo` runs in
  the session's own worktree via argv. Soft-delete only ever touches messages in the scoped `:cid`
  channel after the computed cursor, and is a **soft** delete (`deleted_at`) — recoverable, audit-safe.
- **No secrets anywhere new.** Proposals carry a prompt + plan text; turns carry a sha + message id;
  steering carries a guidance string — all non-secret. Secrets stay on the #25 `SecretsResolver` path
  and are still redacted from streamed output (the execution + plan-mode sessions go through the same
  `makeRedactor`).
- **Default-off, zero blast radius.** The new `LaunchInput` plan-mode env, `SessionManager.steer`,
  `RunningSession.steer`, and `GitWorkspaceService.resetTo` are all additive; with no plan/steer/revert
  call the #25/#50/#51 paths and their tests are byte-for-byte unchanged. Checkpoint/revert routes
  501 without a configured git repo, so CI never needs one.

## Testing strategy
- **Unit (hermetic, no DB — `pnpm test`):**
  - **Plan logic (`plan.ts`):** `decidePlan` maps the three verbs and refuses a second decision;
    `composeExecutionTask` includes the plan, adds the feedback only for `approve_with_feedback`, and
    throws on `reject`; `parsePlanProposal` extracts the delimited block and returns `null` when
    absent; `validateDecisionInput` requires feedback for approve-with-feedback, forbids it otherwise,
    bounds length, and rejects an unknown verb — all with content-free errors.
  - **Revert selection (`checkpoint.ts`):** `planRevert` for a middle turn returns the previous turn's
    sha + cursor and discards target..end; for the first turn returns the **base** sentinel + the
    session launch cursor; unknown/empty throws; already-reverted turns are excluded by the caller and
    a property check asserts the discarded set is always a contiguous suffix.
  - **Controller (`controller.ts`) with fakes:** `propose` launches a plan-mode session
    (`AGENT_PLAN_MODE=1`), never launches execution, and persists `proposed`; `decide(approve)` launches
    execution with the composed task and records a turn; `decide(reject)` launches **nothing**;
    `checkpoint` commits + inserts a turn at the next idx with the sha + cursor; `revert` calls
    `git.resetTo` with the prior sha and `softDeleteMessagesAfter` with the prior cursor and marks the
    suffix reverted. A `decide` on an already-decided proposal 409s (no second launch).
  - **Manager steer seam (`session-manager.test.ts`):** `steer` on a live session calls the running
    session's `steer`; on an unknown/terminal session returns false; a runtime without `steer` returns
    false — and the existing `["AGENT_TASK"]`-only env / streaming / reaper tests stay green
    (plan-mode env only appears when the controller sets it).
  - **Harness/local stdin (`local`/`harness` tests):** opening stdin as a pipe doesn't change the
    streamed output or exit mapping; the `demo`/`claude-code` specs are unchanged.
  - **Git reset (`git-workspace.test.ts`):** against a real temp repo — two `commitTurn`s, then
    `resetTo(sha1)` drops the second turn's file and leaves the first; `resetTo(base)` returns the
    worktree to the base tree.
  - **Messages (`messages`):** `softDeleteMessagesAfter` soft-deletes only messages created after the
    cursor (exclusive) in the scoped channel and returns the count; `latestMessageId` returns the most
    recent non-deleted id (or null).
- **Integration (real Postgres/Redis, LocalRuntime + steerable demo harness + a temp git repo —
  `pnpm test:integration`):**
  - **Plan blocks until approval:** `POST /plans` (the plan-mode run proposes a plan, no work);
    assert **no** execution session exists; `POST /plans/:id/decide {approve_with_feedback, feedback}`
    launches execution with the feedback in its task (assert via the demo harness echo); a separate
    proposal `decide {reject}` launches nothing.
  - **Revert restores conversation + files:** drive two checkpoints on a session worktree (write file
    A + post messages → checkpoint; write file B + post messages → checkpoint), then
    `POST .../turns/:turn2/revert`: assert file B is gone + file A remains (git) **and** turn-2
    messages are soft-deleted while turn-1 messages remain (conversation).
  - **Steering redirects a live agent:** launch a steerable session, `POST .../steer {guidance}`,
    and assert (a) the guidance is posted into the channel and (b) the demo harness echoes
    `steer: <guidance>` into its streamed output (live delivery).
  - **RBAC/IDOR:** a `read`-only member gets 403 on propose/decide/revert/steer; a cross-channel/
    cross-tenant session/plan id 404s; checkpoint/revert 501 when no git repo is configured.
  - Per-workspace isolation via a unique slug (the established shared-Postgres trick); cleanup by slug.
- The demo (`scripts/demos/30-plan-checkpoints-steering.sh`, recorded as the PR video) runs the full
  loop: propose a plan → **approve-with-feedback** → **steer** the running execution → **revert** a
  turn (file + chat) → plus a denied action proving the RBAC gate holds.

## Boundaries
- **Always:** block execution until a plan is decided; run the execution as the **same** agent member;
  thread plan/feedback/guidance as **data** (`AGENT_TASK` / stdin), never argv; derive every git ref
  and worktree path from the **server-issued** session id; write-gate revert + steer (read-gate lists);
  soft-delete (never hard-delete) on revert; default the new seams OFF so #25/#50/#51 are unchanged;
  501 checkpoint/revert without a configured repo; write the failing test first; attach the demo video.
- **Ask first:** approve-and-hand-off to a different agent (A2A/#59 wiring); auto-checkpoint per model
  turn from the stream-json parse; promoting steering to the real `claude-code` resumable-session
  protocol; making revert a hard delete.
- **Never:** launch execution before a plan is approved; interpolate a plan/feedback/guidance string
  into argv; revert to a client-supplied sha; soft-delete messages outside the scoped channel; steer a
  session the manager is not driving; put a secret in a proposal/turn/guidance; merge without approval
  + video.

## Success criteria
1. An agent proposes a plan and **work blocks** until a human approves / approves-with-feedback /
   rejects it; approve-with-feedback threads the note into the execution (integration).
2. Reverting a turn restores **both** the working tree (git reset) and the conversation (message
   soft-delete) to before that turn (integration + unit).
3. A steering message is delivered to a **live** session and recorded in the channel (integration +
   unit seam).
4. RBAC/IDOR holds (write-gated mutations, tenant-scoped reads, 501 without a repo).
5. `pnpm typecheck && lint && test && build` green; integration green.
6. ADR-0030 + this spec + demo script `scripts/demos/30-plan-checkpoints-steering.sh` (the runnable
   proof; recorded video pending); PR links #53; **not**
   merged.

## Plan (atomic)
1. `drizzle/0053_plan_checkpoints_steering.sql` (+ `.down.sql`) + schema `plan_proposals` +
   `session_turns`; repos `plan-proposals.ts` + `session-turns.ts`; messages repo
   `latestMessageId` + `softDeleteMessagesAfter` — *slice 1*.
2. `turns/plan.ts` + `turns/checkpoint.ts` (pure) with unit tests — *slice 1*.
3. Seams: `runtime/types.ts` `RunningSession.steer?`; `runtime/manager.ts` `SessionManager.steer` +
   plan-mode launch env (already supported via `harnessEnv`); `runtime/local.ts` stdin pipe + `steer`;
   `git/workspace.ts` `resetTo` — *slice 2*.
4. `turns/controller.ts` `TurnController` (propose/decide/checkpoint/revert) + `routes/turns.ts`
   (plans/decide/checkpoint/turns/revert/steer); wire into `app.ts`; steerable demo harness — *slice 3*.
5. Tests (unit per slice; integration in slice 3), demo script, README + `.env.example` note — *with
   each slice*.
6. ADR-0030 + demo recording + PR (links #53, not merged) — *ship*.

> Approach: defaults-and-go per the maintainer's mandate (DEFINE → PLAN → BUILD with TDD → demo → PR;
> reviewed and merged by @gagan114662 on the video). No merge without approval.
