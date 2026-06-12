# Spec: Workspace catalog + visual workflow builder (Issue #152)

> Implements [#152](https://github.com/gagan114662/agent-skills/issues/152). Lifecycle: **DEFINE**
> artifact (`spec-driven-development`). The second-wave incident.io **Catalog / Workflows / Insights**
> class. **Generalizes** [#147](../adrs/0147-ona-class-agent-infra.md) (PR for automations: the
> opt-in supervisor shape, the pure `decide` core, the `computeNextRun` schedule seam, the webhook
> token model, the venture-gated draft-only launcher) into multi-step **trigger → condition → action**
> chains, and adds a structured **catalog** of marketing assets agents read for context.

> Reuses [#13](../adrs/0013-approval-gates.md) (`external.send` sensitive-by-default — a `draft_send`
> action becomes a **pending** approval, never an egress), [#123](../adrs/0123-marketing-department-fleet.md)
> (the venture-gated, draft-only department launcher — an `agent_task` action launches through it
> verbatim), [#96](../adrs/0096-venture-loop.md) / [#71](../adrs/0040-cloud-scale.md) (the venture
> admission + tenant budget/concurrency caps every launch clears), [#117](../adrs/0117-self-healing-flywheel.md)
> (a **failed** firing fingerprints + dedupes like any other failure), [#8](../adrs/0008-notifications.md)
> (the `notify_owner` action), [#58](../adrs/0035-config-layering.md) (the layered per-tenant config),
> and [#99](../adrs/0099-disaster-recovery.md) (the maintenance pause before any tick DB call).

> **Numbering note.** Spec / ADR / migration use the `152` / `0152` slot (the issue number), per the
> project's by-issue numbering convention (ADR-0099's note) — chosen to dodge sibling-workspace
> collisions in the shared Conductor Postgres migration sequence.

## Problem

incident.io's **Catalog** "puts the right context at your team's fingertips" and **Workflows**
"automate processes and stay consistent at scale," with **Insights** showing how those workflows
trend. ipop has the primitives (the #123 launch path, the #13 gate, the #147 scheduler, the #117
flywheel) but no owner-facing surface that (a) records *what the workspace's marketing assets are* so
agents stop re-asking, (b) lets the owner compose *if-this-then-that* automations richer than a single
scheduled task, and (c) shows *how those automations are doing*. The hard part is wiring these so an
unattended firing keeps **every** gate a human action has, and so none of it changes behavior until an
owner opts in.

## Goals

1. **Workspace catalog** — a tenant-scoped registry of marketing assets (site, brand kit, social
   account, email domain, ad account, analytics property, venture, deployed app, repo, other) with
   ownership, status, and provenance. Agents read it through the same identity-gated REST surface they
   already use; the console gets a Catalog pane. Default-OFF.
2. **Visual workflow builder** — generalize #147 automations into **trigger → condition → action**
   chains stored as data, decided by a pure evaluator, executed over existing task/approval paths:
   - **trigger:** `schedule` (reusing `computeNextRun`) / `webhook` / `catalog_change` / `channel_event`.
   - **condition:** an AND-list of pure predicates over a facts bag (catalog rollups + a metrics seam).
   - **action:** `agent_task` (the #123 draft-only launcher), `draft_send` (a #13 pending approval),
     `notify_owner` (a #8 notification). **No new egress.**
3. **Run history + insights** — every firing is recorded; the console shows the success/failure trend
   (incident.io's Insights); a failed firing feeds the #117 flywheel.

## Constraints (from the issue + house rules)

- Pure decision modules + IO seams; **default-OFF**; **tenant-scoped** on all catalog/workflow data.
- **Caps on firings per day** (the workflow rate window defaults to 1440 minutes).
- Migrations numbered `0152-*`; TDD; spec + ADR; **all external sends stay approval-gated**; no secrets
  in code; existing gates never weakened.

## Design

### Data (migration `0152_catalog_workflows`)

- `catalog_entries` — one row per asset. `kind` / `status` / `provenance` CHECK-constrained;
  `owner_member_id` nullable; `metadata` jsonb; `workspace_id` cascade carries the #3 boundary.
- `workflows` — `trigger_kind` (CHECK) + `trigger` jsonb (cadence / catalog kind / channel id),
  `conditions` jsonb (AND-list), `actions` jsonb (ordered), `webhook_token_hash` (sha-256 only),
  `enabled` default false, `next_run_at` scheduler cursor.
- `workflow_runs` — the durable ledger: `trigger` + `status` (`fired`/`skipped`/`blocked`/`failed`) +
  `reason` + `results` jsonb (per-action kind/status/ref — **never** secrets).

### Pure core (unit-tested, no IO)

- `workflows/conditions.ts` — `resolveFact` (dot-path) + `evaluateOne` (per-op) + `evaluateConditions`
  (AND-list, first-failed index). Empty list ⇒ vacuously met.
- `workflows/decide.ts` — `decideWorkflowRun`: the #147 ladder plus a `conditions` rung
  (caps → workflow → kill → due → **conditions** → rate → run).
- `workflows/facts.ts` — `buildCatalogFacts`: rolls catalog rows into `catalog.<kind>.{count,active,…}`
  plus a `metrics.*` seam (empty by default), the dot-path facts a condition addresses.
- `workflows/insights.ts` — `aggregateWorkflowInsights`: status counts, success rate (excludes skips),
  recent failure reasons, daily fired/failed buckets.
- `workflows/caps.ts` + `catalog/caps.ts` — default-OFF policy resolution.

### IO engine (`workflows/engine.ts`)

Mirrors the #105/#147 supervisor: opt-in `start(intervalMs)`, `tickAll()` (maintenance check first),
`tickWorkspace` (config flag → kill switch), `runWorkflow` (resolve facts → `decideWorkflowRun` →
execute actions → roll up status → record). Action seams: `launcher` (the #123 venture-gated, draft-only
launch), `draftSendGate` (a #13 pending `external.send`), `notifier` (#8). A `failed` run calls the
optional `flywheelRecord` seam with class `workflow_fail`. `fireEvent(workspaceId, kind, ctx)` runs the
`catalog_change` / `channel_event` triggers; the catalog route calls it best-effort after a mutation.

### Routes (tenant-scoped via `assertWorkspace`)

- `/workspaces/:wid/catalog` GET/POST + `/:id` PATCH/DELETE — **flag-gated** (403 when `catalog` off).
- `/workspaces/:wid/workflows` GET/POST, `/:id/enable|run|runs`, `/workflows-insights`,
  public `/workflows/hooks/:token`. CRUD is always allowed; **firing** is what the flag controls.

### Config (default-OFF, all five sites)

`catalogSchema` + `workflowsSchema` → `settingsSchema`, `ResolvedConfig`, `CONFIG_DEFAULTS`, and the
`mergeSettings` + `mergeLayers` allowlists in `config/layers.ts` (the #98 "new block must be in layers"
gotcha). Env seam: `RELOAD_CATALOG_ENABLED` / `RELOAD_WORKFLOWS_ENABLED`; tick: `WORKFLOWS_INTERVAL_MS`.

### Web (minimal, additive)

`CatalogPanel` (registry table + dark-state on 403) and `WorkflowsPanel` (visual trigger→condition→action
chain, insights strip, builder, run/enable/delete) + two nav tabs in `Workspace.tsx`. Kept out of the
realtime store (the #104 poll pattern) to minimize churn against the in-flight web bug seats (#168/#169).

## Testing

- Unit: `catalog-pure`, `workflows-pure` (conditions/decide/caps/facts/insights), `workflows-engine`
  (action execution, status rollup, conditions gate, kill switch, the flywheel feed) — real pure core
  over in-memory fakes.
- Integration (real Postgres, fake launcher): `catalog` (CRUD + tenant isolation + default-OFF 403),
  `workflows` (create/list/run, the conditions gate, the rate cap, default-OFF, a **real** #13 pending
  approval from `draft_send`, the webhook hook, the `catalog_change` fire).
- Web: `CatalogPanel` + `WorkflowsPanel` render/build/dark-state.

## Non-goals

- A full metrics integration for conditions (the `metrics.*` facts seam is wired but empty by default).
- Automatic `channel_event` wiring into the message post path (left a documented `fireEvent` seam to
  avoid churn against #168/#169); `catalog_change` IS wired (the catalog route owns its own write path).
