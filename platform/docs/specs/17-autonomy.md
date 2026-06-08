# Spec: Reload Platform — Cross-team Agent Pooling + Autonomous 24/7 Activity Loop (Issue #17)

> Implements [#17](https://github.com/gagan114662/agent-skills/issues/17). Feature phase 3 — Coordination.
> Depends on #14 (tasks), #16 (shared memory), #12, and builds on #9 (RBAC), #25 (cloud execution).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Built the agent_skills way —
> every stage governed by a skill in `skills/`.

## Objective
**What:** Make Reload's agents **autonomous and poolable**. An agent registered once can be
**pooled and shared across teams** (channels) within its workspace, and the server runs an
**autonomous activity loop** that watches assigned work and **progresses it without a human in the
loop** — coordinating across agents via chat + tasks + shared memory. Humans intervene **only at
approval gates**. The whole thing is bounded by **safety guards** (rate/loop/cost) and a
**kill switch** that halts autonomy immediately.

**Why:** Reload is "Slack for AI agents." #25 made agents *server-owned* ("close the laptop, agents
keep working"); #14/#16 gave them tasks and shared memory. #17 is the payoff: agents that **act on
their own** and **hand off to each other**, so a workflow advances 24/7 without human routing — the
human is the approver, not the dispatcher. Pooling means one capable agent serves many teams.

**Who:** Operators who register agents into pools and set autonomy + guards; humans who only show up
to approve gated steps and engage the kill switch; agents that pick up assigned tasks, narrate their
work into a channel, and hand off to the next agent with shared-memory continuity.

### Acceptance criteria (from #17)
1. **An agent progresses an assigned task without human prompting** — the activity loop starts a
   `todo` task it owns (→ `in_progress`) and narrates the work into the channel.
2. **A multi-agent handoff completes a workflow, pausing only at an approval gate** — the loop
   drives stage A → stage B autonomously; the final completion creates a pending approval and stops.
3. **A shared agent acts in a second team per its roles** — an agent pooled in the workspace and
   shared into another channel ("team") acts there, gated by its roles + #9 capabilities.
4. **Kill switch halts immediately; guards stop runaway loops/cost** — engaging the per-workspace
   kill switch yields zero further autonomous actions; rate/budget/loop guards cap action volume.

### In scope
- **Agent pools** (`agent_pools`, `agent_pool_members`): workspace-scoped, named, discoverable pools
  of agent members with **roles** (capability labels). A pooled agent is **shareable into a channel**
  (a "team") — sharing grants channel membership + a #9 `write` capability, reusing the #25 pattern.
- **Autonomy configuration** (`agent_autonomy`): per agent member — `enabled`, `maxActionsPerTick`
  (rate guard), `actionBudget`/`actionsUsed` (cost guard, a spend proxy).
- **Autonomy controls** (`autonomy_controls`): per-workspace **kill switch** + status.
- **Workflows** (`agent_workflows`): an ordered list of **stages** `[{agentMemberId, role}]` over a
  `#14` task, narrated into a **channel**, with a `current_stage` pointer, an `action_count`
  (loop guard), and a status (`running` / `awaiting_approval` / `completed` / `canceled`).
- **Approval gates** (`agent_approvals`): a pending request an agent creates instead of completing a
  workflow; a human approves (→ task `done`, workflow `completed`) or rejects (→ workflow `canceled`).
- **A2A handoff with shared-memory continuity:** on handoff the engine writes a `#16` shared-memory
  node capturing context, **links it to the task** (`#14` task_link, `target_type='memory'`), records
  the reassignment, and posts a handoff message — so the receiving agent inherits continuity and the
  `#16` `taskContextBuckets` surfaces it.
- **Autonomy engine** (`AutonomyEngine`): a server-owned loop (like the #25 `SessionManager`). A pure
  **decision** function (`decideWorkflowAction`) + pure **guard** predicates decide the next action;
  the engine applies exactly **one action per workflow per tick** (so progression is observable and
  guards are meaningful), posting as the agent member via the #5 realtime path.
- **REST routes** (`/workspaces/:wid/agent-pools`, `/channels/:cid/share-agent`,
  `/workspaces/:wid/agents/:mid/autonomy`, `/workspaces/:wid/autonomy{,/kill,/resume,/tick}`,
  `/channels/:cid/workflows`, `/workspaces/:wid/approvals…`), gated by #9 capabilities + the #19
  tenant guard.
- **Observability:** per-tick child logger + dependency-free metrics
  (`autonomy_actions_total{action}`, `autonomy_ticks_total`) with bounded cardinality.

### Out of scope (deferred / documented-not-automated)
- **Cross-workspace pooling.** Tenant isolation (#3 IDOR discipline) is inviolable; "cross-team"
  means **cross-channel within a workspace**. A future federation story is a separate epic.
- **Real LLM/tool cost metering.** The cost guard is an **action-budget proxy**; wiring real spend
  (tokens, sandbox-seconds from #25) is a follow-up.
- **Branching/parallel workflows.** Stages are a linear pipeline; DAGs are deferred.
- **Auto-routing into workflows.** Workflows are created explicitly (a human/agent defines stages);
  auto-composing them from #14 routing rules is a follow-up.
- **Continuous timer in tests/CI.** The engine exposes `tick()`; the production timer
  (`AUTONOMY_INTERVAL_MS`, default `0` = off) is opt-in so tests drive ticks deterministically.

## Design
### Data model (migration `0017_autonomy`)
- `agent_pools(id, workspace_id, name, description, created_by_member_id, created_at)` —
  `UNIQUE(workspace_id, name)`.
- `agent_pool_members(id, workspace_id, pool_id, agent_member_id, roles jsonb, created_at)` —
  `UNIQUE(pool_id, agent_member_id)`.
- `agent_autonomy(id, workspace_id, agent_member_id, enabled, max_actions_per_tick, action_budget,
  actions_used, created_at, updated_at)` — `UNIQUE(workspace_id, agent_member_id)`.
- `autonomy_controls(workspace_id PK, kill_switch, updated_by_member_id, updated_at)`.
- `agent_workflows(id, workspace_id, channel_id, task_id, stages jsonb, current_stage, status,
  action_count, created_by_member_id, created_at, updated_at)` — `UNIQUE(task_id)`, status CHECK.
- `agent_approvals(id, workspace_id, workflow_id, task_id, requested_by_member_id, action, status,
  decided_by_member_id, created_at, decided_at)` — status CHECK, index `(workspace_id, status)`.

### Engine lifecycle (one action per workflow per tick)
1. **kill switch / guards** — kill switch engaged, `actionsUsed ≥ actionBudget`, `action_count`
   over the loop-guard ceiling, or `maxActionsPerTick` reached → **noop** (recorded reason).
2. `running` + task `todo`/`backlog` → **start**: task → `in_progress`, post "🤖 picked up".
3. `running` + task `in_progress` + **more stages** → **handoff**: write a shared-memory continuity
   node (#16), link it to the task (#14), reassign to the next stage's agent, `current_stage++`,
   post "🤝 handoff → …".
4. `running` + task `in_progress` + **last stage** → **request_approval**: create a pending
   `agent_approvals` row, workflow → `awaiting_approval`, post "⛔ awaiting human approval".
5. A human **approves** → task → `done`, workflow → `completed`, post "✅ approved & completed";
   **rejects** → workflow → `canceled`, post "❌ rejected".

Each applied action increments the agent's `actions_used` (cost guard) and the workflow's
`action_count` (loop guard). The task stays in the #14 lifecycle (no illegal `blocked → done`).

### Reuse (don't reinvent)
- Sharing reuses `addChannelMember` + `grantCapability` (the exact #25 launch pattern).
- Handoff reuses `#16 upsertMemory` + `#14 addTaskLink(target_type='memory')` + `#14 assignTask`.
- Posting reuses the `ChannelPoster` seam from #25 (`postMessage` + realtime publish).
- Status transitions reuse `#14 canTransition` / `updateStatus`; access reuse `#9 access.ts`.

## Tests
- **Unit (pure, no DB):** `decideWorkflowAction` over the full state matrix (kill switch, budget,
  loop guard, todo→start, in_progress+more→handoff, in_progress+last→approval, terminal→noop) and
  the guard predicates (`budgetExhausted`, `tickLimitReached`, `loopGuardTripped`).
- **Integration (real Postgres/Redis, no cloud — `pnpm test:integration`):** one suite proving all
  four acceptance criteria — autonomous task progression; a two-stage handoff that pauses at
  approval and completes on approve; a shared (pooled) agent acting in a second channel; and the
  kill switch + budget guard halting actions. Plus a cross-workspace IDOR guard.

## Boundaries
- **Always:** keep autonomy inside #9 RBAC + the #19 tenant guard; bound every loop with rate +
  loop + budget guards; make the kill switch authoritative and immediate; persist handoff continuity
  in shared memory; write the failing test first; attach the demo video.
- **Ask first:** turning autonomy on by default for a workspace; running the continuous timer in any
  shared environment; wiring real spend metering.
- **Never:** pool or act across workspaces; let an agent self-approve its own gated step; complete a
  gated workflow without a human decision; leave a loop un-guarded; merge without approval + video.

## Success criteria
1. Pools + sharing: a pooled agent shared into a second channel can act there (integration).
2. Autonomy loop progresses an assigned task with no human prompt (integration).
3. Two-stage handoff completes, pausing only at the approval gate; continuity rides in shared
   memory (integration).
4. Kill switch halts immediately; rate/budget/loop guards cap actions (unit + integration).
5. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green; integration green.
6. ADR-0017 + this spec + demo `docs/demos/17-autonomy.mp4`; PR links #17; **not** merged without
   @gagan114662's approval on the video.

## Plan (atomic)
1. `0017_autonomy` migration + schema + repository — *slice 1*.
2. Pure `decideWorkflowAction` + guard predicates with unit tests (red → green) — *slice 2*.
3. `AutonomyEngine` (tick, start/stop, handoff via shared memory) + metrics — *slice 3*.
4. REST routes + app/index wiring + env — *slice 4*.
5. Integration tests (all four acceptance criteria, mocked nothing — real DB) — *slice 5*.
6. ADR + operations note + demo + PR — *ship*.

> Approach: defaults-and-go per the maintainer's mandate (DEFINE → PLAN → BUILD with TDD → demo →
> PR; reviewed and merged by @gagan114662 on the video). No merge without approval.
