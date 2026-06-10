# ADR-0042 — The autonomy engine launches real agent sessions

**Status:** Accepted · **Issue:** #84 · **Date:** 2026-06-10 · **Depends on:** #17, #25 ·
**Part of:** EPIC #60 · **Ties:** #50, #17

## Context
The #17 `AutonomyEngine` (ADR-0017) is the server-owned activity loop: a `tick()` makes one fair
pass over a workspace's `running` workflows and applies at most one decided action per workflow,
gated by the kill switch, per-agent rate limit, per-agent cost budget, and a loop guard.

But `apply("start")` only did `updateStatus(in_progress)` + `bumpWorkflowAction` + a channel post
("🤖 picked up task … starting autonomously."). **No `SessionManager` was a dependency of the
engine, and no agent session was ever launched.** The loop narrated task-status transitions and
handoffs but never invoked the harness — "autonomous agents keep working" was a status machine plus
narration, not execution. That is the gap #84 closes against the "runs real coding agents
autonomously" claim.

The #25 `SessionManager` already owns real execution end to end (provision → run → stream → reap →
finalize), server-side and independent of any client. The other orchestrators that need to run an
agent — Team Mode (#48), subagents (#59), plan/turns (#53) — all reach it through a small injected
**launcher seam** (`launch` + `join`), never by importing the manager. The engine should do the
same.

## Decision
Give the engine an **optional `AutonomyLauncher`** dependency and have `start`/`handoff` launch a
real session through it, then feed the session's terminal status back into the task so the loop
closes.

- **Launcher seam.** `AutonomyLauncher` = `launch(input) → {id}` · `join(id)` · `status(id)`. The
  `SessionManager` satisfies `launch`/`join` structurally; `status` is the one addition, read from
  the finalized session row (`getAgentSessionStatus`). The production adapter
  (`autonomyLauncherFrom`) wires the shared app `SessionManager`; a missing session reads as
  `failed` (fail-safe → the task blocks rather than hanging "in progress").

- **Launch on `start`/`handoff`.** `start` launches the current stage's agent; `handoff` launches
  the next stage's agent after the existing A2A handoff bookkeeping. The session runs **as the
  stage's agent member**, in the workflow's channel, with the task composed as the harness prompt
  (data via `AGENT_TASK`, never argv). A launch that throws blocks the task — it is never silently
  stranded.

- **Admission: one live session per workflow.** The engine tracks in-flight sessions in memory;
  a tick **skips** a workflow that already has a live session (`noop:session_running`) instead of
  acting on top of it (e.g. escalating to approval while the agent is still working). Combined with
  the existing kill-switch/budget/rate-limit/loop guards — all evaluated *before* `apply` — the
  launch is admitted through exactly the same gates as every other action.

- **Closing the loop — through the human approval gate (#13/#20).** A successful run **never drives
  `done` directly**: autonomy does the work, but a human (or an explicit auto-approve policy rule)
  closes it. When a session settles (off the tick, so `tick()` never blocks on a run):
  - **completed**, final stage → create an approval (`complete_workflow`) + park the workflow at
    `awaiting_approval` — the same gate the narration path's `request_approval` action uses. The
    existing `approve()` then drives the task to `done` + the workflow to `completed`; `reject()`
    drives the task to `blocked` + cancels the workflow (the mirror of approve).
  - **completed**, earlier stage → admission clears so the next tick hands off to the next stage;
  - any non-`completed` terminal (`failed`/`timeout`/`idle_reaped`/`canceled`) → task `blocked`
    directly, **no gate** (work that did not land needs human attention, not approval). All writes
    go through the same `canTransition` status guard as the rest of the engine.

  So both the approval (`completed → awaiting_approval → approve → done`) and the failure/rejection
  (`failed`/`reject → blocked`) edges close the loop, and a human (or policy) is always on the
  `done` edge — the launcher path adds execution without removing the safety gate.

- **No launcher → unchanged.** When no launcher is wired the engine keeps its prior narration-only
  behaviour, so the #17 pooling/autonomy suite (which injects no launcher) is untouched.

## Consequences
- Autonomy now **executes** work: a `tick()` persists and drives a real `agent_sessions` row, its
  output streams into the channel as the agent member (via the #25 path), and the task lands in a
  terminal state from the run's own result — not from a narrated guess.
- The human approval gate (#13/#20) is preserved on **both** paths: the launcher path runs the real
  session and then parks the result at the same `awaiting_approval` gate the narration path uses, so
  a human (or an explicit auto-approve policy rule) is always on the `completed → done` edge. The
  session run is the *work*; approval is the *acceptance*.
- The in-flight set is **per process** (in memory). A multi-instance deployment would need a durable
  lease to keep "one session per workflow" across instances; today the production timer runs in a
  single server process (ADR-0017), so this is sufficient and called out as a follow-up.

## Tests
- **Unit** (`autonomy-engine-launch.test.ts`) — the engine on a **fake SessionManager** with mocked
  persistence: a `start` action launches once with the right channel/agent/task; the kill switch and
  an exhausted budget each block the launch; a completed final-stage session **requests approval**
  (never drives the task to `done`); a failed session **blocks** the task.
- **Integration** (`autonomy-launch.test.ts`) — the engine over a real `SessionManager` + a fake
  runtime (real Postgres + Redis, no cloud): `tick → launch → complete → awaiting_approval →
  approve → done`, the same up to `reject → blocked` (workflow canceled), and a workflow with a live
  session is skipped (`session_running`) rather than escalated.

## Follow-ups (deferred)
- A durable per-workflow lease so "one session per workflow" holds across multiple server instances.
- ✅ **Done** — An explicit **auto-approve policy** for the `completed → awaiting_approval → done` edge.
  A workspace-scoped `autonomy.complete` policy rule (reusing the `approvals/policy.ts` rule model —
  same `approval_policies` storage and routes) opts a trusted workflow out of the human gate: on a
  completed final stage the engine evaluates the rule (via the injected `completionPolicies` seam) and,
  when it auto-approves, decides the gate **by policy** — driving the task to `done` + the workflow to
  `completed` and recording **which rule fired** on the approval (`decision_source='policy'`,
  `policy_rule_id`, migration `0084`). `autonomy.complete` is sensitive by default, so with **no rule**
  the human gate holds exactly as before; rejection/failure semantics are unchanged. Tests:
  `autonomy-engine-launch.test.ts` (unit: no-rule gates, rule auto-approves with audit, rule-requires-
  approval still gates) and `autonomy-auto-approve.test.ts` (integration: tick → launch → complete →
  auto-approve → done, and per-workspace isolation — a rule in one workspace never auto-approves
  another).
- Feed real run cost (tokens, #25 sandbox-seconds) from the settled session into the #17 cost guard.
