# ADR-0147: Ona-class agent infrastructure — automations, task templates, audit trail, live mission control

- **Status:** Accepted (shipped in PR for #147)
- **Date:** 2026-06-11
- **Context issue:** [#147](https://github.com/gagan114662/agent-skills/issues/147)
- **Spec:** [docs/specs/147-ona-class-agent-infra.md](../specs/147-ona-class-agent-infra.md)
- **Builds on:** [ADR-0123](0123-marketing-fleet.md) (the per-department draft-only personas + the
  venture-gated subagent launch path — automations reuse it verbatim, so external sends stay #13-gated
  with no new authority), [ADR-0105](0105-fleet-watchdog.md) (the supervisor pattern: opt-in tick,
  kill-switch/maintenance gating, durable definition + run tables, pure `decide` + IO engine),
  [ADR-0096](0096-venture-loop.md) / [ADR-0040](0040-cloud-scale.md) (the #96 admission gate + #71
  tenant budget/concurrency caps every launch already clears), [ADR-0013](0013-approval-gates.md)
  (external sends sensitive-by-default; the append-only `approval_events` chain), [ADR-0025](0025-cloud-execution.md)
  (`SessionManager` live-session list, `steer`/`cancel`), [ADR-0050](0050-founder-console.md) (the
  read-only console surface), [ADR-0099](0099-disaster-recovery.md) (the maintenance Redis flag).

> **Numbering note.** Spec/migration/ADR all use the `147`/`0147` slot (the issue number), per the
> project's by-issue numbering convention — chosen to dodge sibling-workspace collisions in the shared
> migration sequence.

> **Relationship to #152.** Issue #152 (the workflow builder) will *generalize* automations into
> multi-step workflows. This ADR therefore keeps the trigger model deliberately small and
> **data-driven**: a `trigger_kind` enum + a JSON `schedule` cadence + a flat `params` bag, no step
> graph and no cron parser. #152 widens the `schedule` schema and the pure `computeNextRun` seam
> without touching the launch/gating path.

## Context

The platform runs real cloud agents (#68), supervises stalled ones (#105), and gates their outbound
actions (#13). What it lacks, relative to ona.com, is the **owner's control surface**: a way to make an
agent task *repeatable on a trigger*, a *gallery* of ready tasks, an *audit trail* of what the fleet
did, and a *live view* of what it is doing right now. The hard part is not building any of these from
scratch — every primitive exists (the #123 launch path, the #13 gate, the #25 session list, the #105
heartbeat). The hard part is wiring them so that (a) an unattended, scheduled launch keeps **all** the
same gates a human @mention does, (b) the audit trail is a faithful read model and not a second source
of truth that can drift, and (c) none of it changes behavior until an owner opts in.

## Decisions

1. **Mirror the #105 watchdog for automations.** Automations are a third infrastructure-time
   supervisor, so they reuse the proven shape: an opt-in `start(intervalMs)` timer (default 0), a
   `tickAll()` that checks the #99 maintenance flag before any DB call, a per-workspace `tickWorkspace`
   gated on the config `enabled` flag then the #17 kill switch, a **pure `decide` core** with the IO in
   the engine, and a **definition table + run-ledger** pair. New supervisor, same skeleton.

2. **Launch through the #123 marketing path — do not invent a new launch authority.** The engine's
   `AutomationLauncher` seam is bound to the SAME `ventureGatedSubagentLauncher(sessionManager)` the
   marketing fleet uses: `gate.check()` (the #96 venture admission, default-OFF → transparent) then
   `sessionManager.launch()` (the #71 chokepoint: kill switch, tenant budget, concurrency). The agent
   that runs is a #123 **draft-only** department persona (`DRAFT_TOOLS`, no send tool). **Consequence:
   "all external sends stay approval-gated" is structural, not bolted on** — an automation cannot send
   an email or post an ad; it can only draft, and any send leaves the building through the #13 gate
   exactly as a hand-typed @mention would. The automation feature adds zero new egress.

3. **The scheduler is a pure function of a JSON cadence + a clock.** `computeNextRun(schedule, from)`
   supports a small enum of cadences (interval/hourly/daily/weekly, UTC) — enough for "every Monday
   09:00" and unit-testable without a cron library or wall-clock. The engine persists the result in
   `next_run_at` (the cursor) and the `listDue` query is a plain `enabled AND next_run_at <= now`.
   This is the explicit seam #152 widens.

4. **One template registry, two consumers.** The gallery (`TASK_TEMPLATES`) is pure data. The composer
   reads it to pre-fill a message; an automation stores a `template_key` + `params` and the engine
   renders the same body at run time. A template is never duplicated between "run now" and "run every
   Monday" — both resolve through `renderTemplate(key, params)`.

5. **The audit trail is a read model, never a new write path.** There is no generic events table and we
   do not add one. `normalizeAuditEvents` merges three sources the platform **already** writes
   append-only and tenant-scoped — #13 approval requests/events, automation runs, #123 marketing-task
   launches — into one time-sorted feed. Because it only reads, it cannot drift from state and needs no
   migration of its own. (The `automation_runs` table it reads is created for slice 1 regardless.)
   This matches the issue's framing — "backed by existing events" — and the #112-postmortem precedent
   of surfacing existing rows read-only.

6. **Mission control polls; spend is an estimate.** Matching the #104 console, the pane fetches the
   live list rather than streaming (a `ServerEvent` variant is a deferred optimization, not a
   correctness requirement). `SessionManager` records no per-session cost (#71 aggregates compute per
   tenant window), so the pure builder estimates `ceil(elapsedMinutes) × computeRateCentsPerMinute`
   from the tenant's #71 rate — labeled an estimate. Steer reuses the #53 stdin seam (record the steer
   message as the source of truth, then best-effort deliver); stop wraps `SessionManager.cancel`. Both
   are best-effort and process-local (they act on the instance driving the session), like the existing
   steer route — acceptable for a control surface, and the cancel intent is auditable via the message.

7. **Default-OFF and tenant-scoped throughout.** The only new config block is `automations`
   (`enabled:false` + `AUTOMATIONS_INTERVAL_MS=0`), added at the five canonical sites. Audit +
   mission-control are read-only viewers gated solely by the #19 `assertWorkspace` boundary — every
   query filters `workspace_id`. Wiring the feature changes nothing until an owner opts in and creates
   an automation.

## Consequences

- A new owner capability with **no new egress and no new launch authority** — every gate that bounds a
  human @mention bounds a scheduled one.
- One migration (`0147`, two tables). Audit + mission-control are pure read models. The trigger model
  is small on purpose; #152 extends `computeNextRun` and the `schedule` schema, reusing the launch
  path unchanged.
- Mission-control stop/steer are best-effort + process-local (inherited from #53/#25); the cancel
  intent is recorded as a message so it is auditable even when delivery misses.
- Spend in mission control is an estimate, clearly labeled — exact per-session cost would need a #71
  schema change (out of scope).
