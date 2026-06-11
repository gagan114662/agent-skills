# Spec: Reload Platform — Product Planning Loop: feedback + metrics → ranked backlog → specs → agent sessions (Issue #115)

> Implements [#115](https://github.com/gagan114662/agent-skills/issues/115). Phase 6 — the platform
> decides **what to build next**. **Builds on #117** (the infrastructure-time supervisor pattern:
> opt-in tick, kill-switch / maintenance gating, durable bounded tables, pure `decide`/pure-rank + IO
> engine, #92 launcher reuse, #95 policy auto-approve, #13 queue, #71 dollar ceiling, #104 read
> surface), **#96** (the venture-gated `AutonomyLauncher` — a proposed build session clears the
> fundable-venture gate first), **#102** (growth metrics as a backlog source), **#106** (outcome
> verifier gaps as a backlog source), **#114** (Customer Voice insights as a backlog source),
> **#13/#95** (sensitive-by-default approvals + policy auto-approve), **#71** (`tenant_usage` budget),
> **#17** (kill switch), **#104** (Founder Console roadmap pane). Lifecycle: **DEFINE** artifact
> (`spec-driven-development`) → atomic plan → TDD failing-first → ADR → one PR. **Video gate waived by
> the owner.**

## Objective

**What:** After v1 ships, *nothing decides what to build next* — agents polish whatever they were last
told to, not what users need, and product planning stays 100% founder labor. The **Product Planning
Loop** turns the evidence the platform already collects — Customer Voice insights (#114), Growth Loop
funnel metrics (#102), and Outcome Verifier gaps (#106) — into a **RICE-ranked backlog**, drafts a
**spec** for the top item, and **proposes an agent build session** through the venture-gated launcher
(#96) — budget-capped, kill-switch aware, and **sensitive-by-default**: pivots and over-budget efforts
queue for a human (#13); only small, policy-allowed items (#95) auto-flow.

Four stages, mirroring the #117 flywheel's structure:

1. **Backlog model** — `addItem(...)` records a workspace-scoped, per-venture `backlog_items` row from
   one of four sources (`customer_voice` / `growth` / `verifier` / `manual`), carrying a `source_ref`
   (the evidence link) and the **RICE evidence inputs**. The pure `rice.ts` module **derives** Reach /
   Impact / Confidence from evidence counts (`deriveRice`) and **scores** RICE = (R × I × C) / Effort
   (`scoreRice`), where Effort is the agent's estimate. Same evidence in → same score (deterministic).
2. **Planning tick** — a scheduled pass (default OFF, kill-switch + maintenance gated) **re-ranks** the
   backlog (`rankBacklog`, pure), takes the **top item**, **drafts a spec** in the repo lifecycle
   format (`draftSpec`, pure — Objective / Why-ranked-here with evidence links / Acceptance), persists
   it, and **proposes an agent session** for it through the **venture-gated #96 launcher**,
   **budget-capped** via `tenant_usage` and kill-switch gated.
3. **Human gates** — the pure `decidePlanningDispatch` routes the proposal: a **pivot** (changes
   product direction) or an **over-budget effort** (effort above the auto-flow ceiling) **queues for
   #13 approval**; a class **not** auto-allowed by a #95 policy rule **queues** (sensitive-by-default);
   only a small, policy-allowed, in-budget item with the kill switch off **auto-dispatches**. Budget
   exhaustion / kill switch **skip the auto path only** (queueing a human consumes no spend).
4. **Founder Console (#104)** — a read-only **roadmap pane**: the ranked backlog with each item's RICE
   score, the **why-ranked-here evidence link**, its lifecycle status, and the dispatch/approval state.

**Default-OFF.** Config `planning.enabled` defaults false and the background tick interval
(`PLANNING_INTERVAL_MS`) defaults 0, so a deployment that opts into nothing is byte-for-byte unchanged
— exactly the #117/#105/#96 posture. Recording backlog items + reading the ranked backlog are always
available (harmless, tenant-scoped); `enabled` gates only the proactive planning posture (the tick).

## Non-goals

- **No new evidence emitters wired hot in v1.** `addItem(...)` is the ingest seam any source calls;
  this PR proves the flow end-to-end with items carrying each source kind and leaves the #114/#102/#106
  reader call-sites as one-line `addItem(...)` adds (the seam is the contract). #114 Customer Voice may
  not yet exist; `customer_voice` is a first-class source so its reader can call `addItem(...)` when it
  lands.
- **No launch-on-approval automation.** A queued #13 approval surfaces in the #104 console; wiring the
  human "approve → launch" action to re-enter the dispatcher is follow-up. The dispatch row records the
  queued approval (mirrors #117's queued dispatch).
- **No model-backed effort estimation.** Effort is supplied with the item (the agent estimate seam);
  an LLM estimator is a deferred follow-up. RICE math is fully real and pure-tested.
- **No backlog editing UI.** The console pane is read-only (the #104 discipline); items are created via
  the API / source adapters.

## Data model (migration `0115_product_planning_loop.sql`)

Numbered `0115` by issue (per ADR-0099's by-issue convention) to dodge sibling-workspace collisions in
the shared migration sequence. Two workspace-scoped tables; every cross-entity reference is a **soft
reference** (no FK) so a backlog record outlives a pruned venture idea / member / approval — only
`workspace_id` carries the #3 tenant boundary (`ON DELETE CASCADE`).

- **`backlog_items`** — one candidate unit of work. `idea_id` (soft) scopes it to a venture (#96) or
  null for workspace-level. `source` ∈ (`customer_voice`,`growth`,`verifier`,`manual`) + `source_ref`
  (the evidence link surfaced as why-ranked-here). RICE evidence inputs: `reach` (distinct corroborating
  signals), `impact` (gap severity tier 0–4), `confidence_pct` (0–100, how corroborated), `effort`
  (agent estimate in points, ≥ 1). `is_pivot` (bool — changes product direction, always #13). `status`
  ∈ (`proposed`,`specced`,`dispatched`,`done`,`rejected`). `target_channel_id` / `target_agent_member_id`
  (soft) — the launch target for an auto-dispatch. `spec_id` / `approval_request_id` (soft) link the
  drafted spec + the #13 gate.
- **`planning_specs`** — the drafted spec for an item. `backlog_item_id` (soft) + `title` + `body`
  (the repo-lifecycle-format markdown) + `status` ∈ (`draft`,`dispatched`) + `session_id` (soft, the
  proposed build session) + `approval_request_id` (soft, the #13 gate when queued).

## Architecture (pure core + IO seam, the #117 split)

- `planning/rice.ts` — **pure**: `deriveRice(evidence)` (counts → R/I/C), `scoreRice(inputs)`
  (RICE = R × I × C / Effort), `rankBacklog(items)` (desc by score; stable, ties by recency).
- `planning/decide.ts` — **pure**: `decidePlanningDispatch(input)` → `auto` | `gate` | `skip` + reason
  (route-first; spend caps gate the auto path only — the #117 `decideDispatch` shape).
- `planning/spec.ts` — **pure**: `draftSpec(item, rank)` → `{ title, body }` repo-lifecycle markdown,
  embedding the why-ranked-here evidence link + RICE breakdown.
- `planning/caps.ts` — `resolvePlanningCaps(cfg)` (default OFF; `autoEffortCeiling` = the over-budget
  threshold; `dispatchCostCents` = the per-dispatch charge against the #71 budget).
- `planning/service.ts` — **IO orchestrator**: one seam per side effect (backlog store, spec store,
  the `SpecDispatcher` launch seam, the `SpecApprovalQueue` #13 seam, `autoDispatchAllowed` #95,
  `budgetExhausted` #71, `killSwitch` #17, `caps`, `now`). `addItem` / `backlog` (ranked read) / `tick`.
- `planning/default.ts` — production wiring: real repos; the `SpecDispatcher` adapts the
  **venture-gated** `AutonomyLauncher` (`ventureGatedLauncher(autonomyLauncherFrom(sessionManager),
  createVentureAdmission())`); the queue creates a **pending** #13 `planning.dispatch` request.
- `routes/planning.ts` — `POST /workspaces/:wid/planning/items`, `GET /workspaces/:wid/planning/backlog`
  (ranked), `POST /workspaces/:wid/planning/tick` (run one pass). Thin adapters over the service, behind
  `requireIdentity` + `assertWorkspace` (the #19 IDOR boundary).
- `founder-console` — a `PlanningReader` seam → the roadmap `PlanningView`.

## Acceptance criteria

- **RICE scoring pure-tested** — `deriveRice` / `scoreRice` / `rankBacklog` unit-tested: counts →
  R/I/C, the (R × I × C)/Effort score, deterministic ranking with stable tie-breaks.
- **Dispatch decision pure-tested** — pivot → gate, over-budget effort → gate, not-#95-allowed → gate,
  budget-exhausted / kill-switch → skip (auto path only), else → auto.
- **Spec drafting pure-tested** — `draftSpec` emits the repo lifecycle sections + the why-ranked-here
  evidence link.
- **Flow proven in integration** — evidence → ranked backlog → drafted spec → **proposed session**
  with a **fake launcher** (asserts the launch happened + the session linked); a **pivot** proves the
  **#13 gate sensitive-by-default** (a pending approval, NOT a launch).
- **Tenant isolation everywhere** — every store query is workspace-scoped; a sibling workspace sees
  none of another's backlog (proven in integration).
- **Default-OFF** — `planning.enabled` false ⇒ the tick is a no-op; the managed layer owns the flag
  (cannot be loosened by a lower layer).
