# ADR-0152: Workspace catalog + visual workflow builder (incident.io Catalog/Workflows/Insights class)

- **Status:** Accepted (shipped in PR for #152)
- **Date:** 2026-06-12
- **Context issue:** [#152](https://github.com/gagan114662/agent-skills/issues/152)
- **Spec:** [docs/specs/152-catalog-workflow-builder.md](../specs/152-catalog-workflow-builder.md)
- **Builds on:** [ADR-0147](0147-ona-class-agent-infra.md) (automations — the opt-in supervisor shape,
  the pure `decide` core, the `computeNextRun` schedule seam, the webhook token model; this ADR is the
  generalization #147 explicitly anticipated), [ADR-0123](0123-marketing-department-fleet.md) (the
  draft-only department personas + the venture-gated launch path — an `agent_task` action reuses it
  verbatim), [ADR-0096](0096-venture-loop.md) / [ADR-0040](0040-cloud-scale.md) (the #96 admission gate
  + #71 tenant budget/concurrency caps every launch clears), [ADR-0013](0013-approval-gates.md)
  (`external.send` sensitive-by-default; a `draft_send` action is a **pending** request, never an egress),
  [ADR-0117](0117-self-healing-flywheel.md) (a failed firing fingerprints like any failure),
  [ADR-0008](0008-notifications.md) (the `notify_owner` action), [ADR-0035](0035-config-layering.md)
  (the layered per-tenant config), [ADR-0099](0099-disaster-recovery.md) (the maintenance pause).

> **Numbering note.** Spec / migration / ADR all use the `152` / `0152` slot (the issue number), per the
> project's by-issue numbering convention (ADR-0099's note) — chosen to dodge sibling-workspace
> collisions in the shared Conductor migration sequence.

## Context

ipop has every primitive incident.io's Catalog/Workflows/Insights surface needs — the #123 launch path,
the #13 gate, the #147 scheduler, the #117 flywheel, the #8 notifier — but no owner control surface that
(a) records *what the workspace's marketing assets are* (so an agent stops re-asking the owner the same
question), (b) composes automations richer than #147's single scheduled task, and (c) shows how those
automations trend. #147 was deliberately built "small + data-driven so #152 can widen it without touching
the launch path." This ADR is that widening.

## Decisions

1. **Generalize #147, don't fork it.** A workflow is the same shape as an automation — an opt-in
   supervisor with a pure `decide` core and an IO engine, a definition table + a run ledger — plus two
   generalizations: the trigger becomes a `{kind, …}` jsonb (schedule/webhook/**catalog_change**/
   **channel_event**) and the single task becomes an ordered **actions** list guarded by an AND-list of
   pure **conditions**. The schedule path *reuses* #147's `computeNextRun` + webhook token helpers
   directly — no duplicated cadence logic.

2. **The decision stays pure; conditions are a new rung, not a new system.** `decideWorkflowRun` is
   `decideAutomationRun` plus a `conditions` rung between *due* and *rate*:
   `caps → workflow → kill → due → conditions → rate → run`. Conditions are evaluated by a pure
   `evaluateConditions(conditions, facts)` over a facts bag the engine resolves once (catalog rollups
   today, a `metrics.*` seam for later). An empty condition list is vacuously met, so a condition-less
   workflow behaves exactly like a #147 automation.

3. **Every action reuses an existing gated path — the feature adds ZERO new egress.** This is the load-
   bearing decision, and it is structural, not bolted on:
   - `agent_task` → the SAME `ventureGatedLauncher(sessionManager)` the #123 fleet uses (so #96 venture
     admission + #71 budget/concurrency caps are inherited) launching a **draft-only** #123 persona.
   - `draft_send` → `createRequest(... status: "pending")`: an `external.send` is sensitive-by-default
     (#13), so the action can only *queue a human approval*. Nothing leaves the building.
   - `notify_owner` → the #8 `notify` service to the workspace owner.
   "All external sends stay approval-gated" therefore holds by construction: a workflow has no send
   authority a hand-typed @mention doesn't, and no path to egress that bypasses #13.

4. **A failed firing feeds the #117 flywheel.** The run-status rollup is: any failed action ⇒ `failed`
   (+ a `workflow_fail` `FailureEvent`, so a broken workflow fingerprints + dedupes into an issue like
   any other failure); all-blocked ⇒ `blocked`; else `fired`. An admission denial or an unseeded agent
   is a **blocked** action (expected, no flywheel feed), distinct from a thrown action (**failed**).
   `workflow_fail` is additive to `FAILURE_CLASSES` (no DB CHECK on the column) and the generic
   `flywheel.fix.<class>` action keeps it sensitive-by-default (queues for a human).

5. **The catalog is a tenant-scoped read model agents already reach.** `catalog_entries` is plain CRUD
   behind `assertWorkspace`; agents read it through the identity they already carry. It is **flag-gated**
   (403 when `catalog` is off) because exposing the asset list is the feature. A catalog mutation fires
   the workflow `catalog_change` triggers **best-effort** (`void engine.fireEvent(...)`, never awaited),
   so a slow agent launch never blocks the catalog write.

6. **Default-OFF, layered, and locked.** Both surfaces are config default-OFF; the new `catalog` /
   `workflows` blocks are added to BOTH `mergeSettings` and `mergeLayers` allowlists in
   `config/layers.ts` (the #98 "a new block not added to layers silently drops at runtime" gotcha), so a
   managed-layer tenant's flag/caps cannot be loosened by a lower layer. The firing timer is opt-in
   (`WORKFLOWS_INTERVAL_MS = 0`); the env layer exposes `RELOAD_CATALOG_ENABLED` /
   `RELOAD_WORKFLOWS_ENABLED` so a deployment can flip them without baking a managed.toml.

## Consequences

- **Caps on firings per day** are literal: the workflow rate window defaults to 1440 minutes, so
  `maxRunsPerWindow` is a per-day ceiling; `maxPerWorkspace` caps definitions and `maxActionsPerRun`
  bounds a single firing's fan-out.
- The CRUD routes for workflows are intentionally **not** flag-gated (creating a workflow can never fire
  until `workflows.enabled`), so an owner can build chains before opting the firing path on.
- `channel_event` is a stored trigger kind with a working `fireEvent` seam, but the message-post path is
  **not** wired to call it (left a documented seam to minimize churn against the in-flight web bug seats
  #168/#169); `catalog_change` IS wired because the catalog route owns its own write path.
- No existing module changed behavior: `decideAutomationRun`, the #13 executor/policy, and the #123
  launcher are untouched; the only edits outside new files are additive (config blocks, a failure class,
  two web nav tabs).

## Alternatives considered

- **Extend the `automations` tables in place.** Rejected: the trigger/condition/action model is a
  superset, and reusing the run-ledger semantics (`fired` vs `launched`, multi-action `results`) would
  have overloaded #147's columns. Separate tables keep both readable and let #147 stay frozen.
- **A `workflow.send` executor that performs the send after approval.** Rejected as unnecessary new
  surface: `external.send` already executes recorded-only after a human approves (#13), so `draft_send`
  just submits to it. No new executor, no new egress, every approval test untouched.
