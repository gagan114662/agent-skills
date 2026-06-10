# ADR-0017: Cross-team Agent Pooling + Autonomous Activity Loop

- **Status:** Accepted (Gagan approved defaults-and-go — issue #17)
- **Date:** 2026-06-08
- **Context issue:** [#17](https://github.com/gagan114662/agent-skills/issues/17) (Phase 3 — Coordination)
- **Builds on:** [ADR-0002](0002-data-model.md), [ADR-0009](0009-registry-rbac.md),
  [ADR-0014](0014-tasks.md), [ADR-0015](0015-memory-graph.md), [ADR-0016](0016-shared-memory.md),
  [ADR-0025](0025-cloud-execution.md)

## Context
Reload is "Slack for AI agents." #25 made agents server-owned (close the laptop, they keep working);
#14 gave them tasks; #16 gave them shared memory. #17 is the coordination payoff: agents must
**act on their own** — pick up assigned work, narrate it, and **hand off to each other** — so a
workflow advances 24/7 **without a human routing each step**. The human becomes the *approver*, not
the *dispatcher*. And one capable agent should serve **many teams**, not be locked to one.

Two forces are in tension: **autonomy** (agents act without prompting) and **safety** (autonomy is
blast radius — runaway loops, cost, an agent acting where it shouldn't). The design exists to make
autonomy real *and* bounded.

## Decisions

1. **"Cross-team" means cross-channel within a workspace, never cross-workspace.** The #3 IDOR
   discipline (a resource in another workspace is a 404) is inviolable and heavily tested
   (`tenant-isolation.test.ts`). A **team** maps to a **channel**; an **agent pool** is
   workspace-scoped. Pooling lets one agent serve many channels/teams; federation across tenants is
   a separate epic. This keeps the strongest existing invariant intact.

2. **Pooling reuses the #25 sharing primitive.** "Share a pooled agent into a channel" is exactly
   `addChannelMember` + `grantCapability(write)` — the same two calls the #25 launch route makes.
   Roles on pool membership describe *what* the agent does; #9 capabilities enforce *whether* it may.
   We did not invent a new ACL system.

3. **The engine mirrors the #25 `SessionManager`: server-owned, deps-injected, with a `tick()`
   seam.** Autonomy is a server-side loop, not client-driven. For determinism, the engine exposes
   `tick()` (one pass) and `start(intervalMs)/stop()`; the production timer is **opt-in**
   (`AUTONOMY_INTERVAL_MS`, default `0` = off) so tests/CI drive ticks explicitly and the shared
   dev DB is never churned by a background loop. `stop()` is called on server close.

4. **One action per workflow per tick, decided by a pure function.** `decideWorkflowAction` and the
   guard predicates are **pure and unit-tested** (matching `selectLeastLoaded` / `canTransition` /
   `rankRelevantContext`). The engine *applies* exactly one action per workflow per tick, so
   progression is observable across ticks and the rate/loop guards are meaningful. The integration
   test drives ticks and asserts the state machine — no flaky timers.

5. **A workflow is a linear pipeline of stages over a #14 task.** `stages = [{agentMemberId, role}]`
   with a `current_stage` pointer. The acting agent starts the task (`todo → in_progress`), then on
   each subsequent tick either **hands off** to the next stage or, on the last stage, **requests
   approval**. Linear (not a DAG) is the smallest model that proves multi-agent handoff; branching is
   deferred. The task never makes an illegal transition — it stays `in_progress` while awaiting
   approval (the *workflow* status, not `blocked`, is the gate signal), avoiding `blocked → done`.

6. **Humans only at approval gates; an agent can never self-approve.** Instead of completing, the
   agent creates a pending `agent_approvals` row and the workflow parks at `awaiting_approval`.
   Approve → task `done` + workflow `completed`; reject → workflow `canceled`. Approval/reject routes
   require a **human** identity (`kind === 'human'`), so autonomy can never close its own gate.

7. **A2A handoff carries continuity in shared memory (#16), not a bespoke blob.** On handoff the
   engine writes a `#16` memory node (`type='handoff'`) with the continuity note, **links it to the
   task** via a `#14` `task_link(target_type='memory')`, reassigns the task, and posts a handoff
   message. The receiving agent inherits context through the existing `taskContextBuckets` retrieval
   — handoff is a *use* of shared memory, not a parallel mechanism.

8. **Three independent safety guards plus an authoritative kill switch.**
   - **Rate guard** — `maxActionsPerTick` caps actions per agent per tick.
   - **Cost guard** — `actionBudget` / `actionsUsed`; an honest **proxy for spend** (real token/
     sandbox-second metering is a documented follow-up). Budget-exhausted → the agent stops acting.
   - **Loop guard** — a per-workflow `action_count` ceiling stops a workflow that churns without
     reaching a gate.
   - **Kill switch** — a per-workspace `autonomy_controls.kill_switch`, checked at the top of every
     tick *and* before applying each action, so engaging it yields **zero further actions
     immediately**. Engage/resume routes are human-only.

9. **Observability extends the #19 registry with cardinality discipline.** A per-tick child logger;
   `autonomy_actions_total{action}` and `autonomy_ticks_total` counters. **No tenant ids as metric
   labels** — they live in logs — preserving the #19 cardinality rule.

## Consequences
- An assigned task advances with no human prompt; a two-agent workflow completes after a single
  human approval — proven by integration tests that drive ticks against a real database.
- A pooled agent shared into a second channel acts there, gated by #9 — "cross-team" without ever
  crossing a tenant boundary.
- Autonomy is bounded by default: every loop is rate/loop/budget-capped and a single switch halts a
  workspace's agents at once. Autonomy stays **off** unless explicitly enabled per agent.
- The continuous timer is opt-in; dev/CI run deterministic `tick()`s, so no background churn.

## Follow-ups (deferred)
- ~~The loop narrates `start`/`handoff` but does not yet launch a real #25 session.~~ **Done in #84
  ([ADR-0042](0042-autonomy-real-sessions.md))**: `start`/`handoff` launch a real agent session
  through the `SessionManager`, gated by the same guards, and the session's terminal status feeds
  back into the task (`done`/`blocked`).
- Real cost metering (tokens, #25 sandbox-seconds) feeding the cost guard + a budget dashboard.
- Branching / parallel (DAG) workflows and auto-composing workflows from #14 routing rules.
- Cross-workspace agent federation (a tenant-boundary-crossing epic of its own).
- A periodic reaper that flags loop-guard-tripped / stuck workflows for human attention.
- Wiring autonomy spans onto the #19 OpenTelemetry propagation seam.
