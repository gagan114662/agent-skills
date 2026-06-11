# Spec: Reload Platform — Ona-class agent infrastructure: automations, task templates, audit trail, live mission control (Issue #147)

> Implements [#147](https://github.com/gagan114662/agent-skills/issues/147). A competitive-gap pass vs
> ona.com. **Builds on #123** (the Marketing Department Fleet: per-department channels + draft-only
> personas + the venture-gated launch path), **#96/#71** (the venture admission gate + tenant
> budget/concurrency caps), **#13** (approval gates; external sends sensitive-by-default), **#105**
> (the watchdog supervisor pattern: opt-in tick, kill-switch/maintenance gating, durable bounded
> tables, pure `decide` + IO engine), **#25** (`SessionManager`, live-session list, steer/cancel),
> **#104** (the read-only Founder Console surface), **#53** (stdin steer). Lifecycle: DEFINE
> (`spec-driven-development`) → atomic plan → TDD failing-first → ADR → one PR. **Video gate waived by
> the owner.**

> **Numbering note.** Spec/migration/ADR all use the `147`/`0147` slot (the issue number), per the
> project's by-issue numbering convention (see ADR-0099's note) — chosen to dodge sibling-workspace
> collisions in the shared migration sequence.

## Objective

ona.com runs "a team of AI software engineers in the cloud — orchestrated, governed, secured." ipop
already runs real cloud agents (#68) supervised by a watchdog (#105) behind approval gates (#13), but
four owner-facing capabilities are missing. This issue ships them as four thin, reuse-first slices:

1. **Automations** — a workspace owner declares a repeatable agent task on a **trigger**: *"every
   Monday, Scout audits my site and posts findings to #seo."* A durable `automations` row carries a
   trigger (schedule or webhook), a task template + params, a target channel, and a department agent.
   A pure scheduler decides when each is due; a default-OFF, kill-switch-gated tick (mirroring the
   #105 watchdog) launches the task **through the existing #123 marketing path** — so every launch
   keeps the #96 venture gate + #71 budget/concurrency caps, and **every external send stays
   #13-gated** (the launched personas are the same draft-only agents — they cannot send without a
   human approving). Per-tenant caps bound runs/window. Each run is a durable `automation_runs` row.
2. **Task template gallery** — six prebuilt marketing task templates per department (SEO audit,
   content calendar, competitor teardown, email sequence draft, ad copy variants, analytics digest),
   pure and data-driven, **pickable from each channel composer**. The SAME registry powers an
   automation's `template_key`, so "run it once now" and "run it every Monday" share one definition.
3. **Audit trail** — an append-only, owner-visible audit pane: *who/what agent did what, when, gated
   by what.* Backed by **existing append-only rows** (approval requests/events #13, automation runs,
   marketing-task launches #123) normalized by a pure merge into one tenant-scoped, time-sorted feed.
   No new event store — the audit trail is a read model over what the platform already records.
4. **Live mission control** — the workspace's running agent sessions, live: status, elapsed, an
   estimated spend, and **steer/stop** controls. Reads the existing #25 live-session list + #105
   heartbeat `progressAt` + #71 usage rate; a pure builder derives elapsed + estimated cost; steer
   reuses the #53 stdin seam and stop wraps `SessionManager.cancel`.

**Non-goals (this PR):** a general workflow/DAG builder (that is **#152**, which will *generalize*
these automations — so the trigger model here is deliberately simple and data-driven: a `trigger_kind`
+ a JSON `schedule` + a flat `params`, no step graph); a streaming WebSocket mission-control feed
(the pane polls, matching the #104 console — a `ServerEvent` variant is a later optimization); a true
cron-expression parser (the schedule is a small enum of cadences — interval/hourly/daily/weekly —
sufficient for "every Monday 09:00" and trivially extended by #152); per-session cost columns (spend
is an estimate from elapsed × the tenant compute rate, the only signal #71 records).

## Architecture

### Automations (the only slice with a migration — `0147`)

Two workspace-scoped tables (mirroring the watchdog/flywheel split — a definition table + a run
ledger), both `ON DELETE CASCADE` on `workspace_id`:

- **`automations`** — the owner's declaration: `name`, `trigger_kind` (`schedule|webhook`), `schedule`
  jsonb (the cadence spec for schedule triggers), `webhook_token_hash` (sha-256 of the one-shown
  token, for webhook triggers), `template_key`, `params` jsonb, `channel_id` (FK channels CASCADE),
  `agent_handle` (the #123 department persona to run as), `enabled` (default **false**),
  `created_by_member_id` (FK members CASCADE — the owner; used as the launch's `createdByMemberId`),
  `last_run_at`, `next_run_at` (the scheduler cursor). Indexed on `(workspace_id)` and
  `(enabled, next_run_at)` for the due-query.
- **`automation_runs`** — the durable ledger: `automation_id` (FK CASCADE), `trigger`
  (`schedule|webhook|manual`), `status` (`launched|skipped|blocked|failed`), `reason`, `session_id`
  (soft ref — a run outlives a pruned session), `task` (the rendered text). Indexed on
  `(workspace_id, created_at)` and `(automation_id)`.

Pure modules (`automations/`, no IO, unit-tested):

- `schedule.ts` — `computeNextRun(schedule, from): Date | null` and `isDue(nextRunAt, now)`. Cadences:
  `interval` (`everyMinutes`), `hourly` (`minute`), `daily` (`hour`/`minute`), `weekly`
  (`dayOfWeek`/`hour`/`minute`). All UTC. A pure function of the spec + a clock — the engine injects
  the clock, tests inject a fixed date. This is the seam #152 widens (add cadences / a cron field).
- `templates.ts` — `TASK_TEMPLATES` (the gallery), `getTemplate(key)`, `templatesForDepartment(dept)`,
  `renderTemplate(key, params)`. Pure: a template is `{ key, department, title, description, body,
  params: TemplateParam[] }`; `renderTemplate` substitutes `{{param}}` placeholders. One registry
  serves both the composer gallery (slice 2) and an automation's `template_key` (slice 1).
- `caps.ts` — `resolveAutomationCaps(cfg)` → `{ enabled, maxRunsPerWindow, windowMinutes,
  maxPerWorkspace }`, all default-OFF (`enabled:false`). The per-tenant cap.
- `decide.ts` — `decideAutomationRun(input): { action: "run"|"skip", reason }`. Pure, route-first:
  caps-disabled → skip; automation-disabled → skip; kill-switch → skip; not-due → skip; over
  runs/window → skip(`rate_limited`); no concurrency headroom → skip; else run. The engine resolves
  every async fact (due, runs-in-window, concurrency) **before** calling.

IO engine (`automations/engine.ts`, `AutomationEngine` class — the #105 shape): seams
`AutomationStore` (durable CRUD + `listDue`/`countRunsInWindow`/`recordRun`/`markRan`/
`findByWebhookHash`/`activeWorkspaces`), `AutomationLauncher` (the venture-gated subagent launcher →
`{id}`), `resolveAgentMember(workspaceId, handle)` (the #123 persona lookup), function seams `caps`,
`killSwitch`, `maintenancePaused?`, `logger`, `now?`. `start(intervalMs)/stop()` opt-in timer;
`tickAll()` (maintenance-gated before any DB call) → `tickWorkspace()` (caps + kill-switch gated) →
for each due automation resolve facts → `decideAutomationRun` → on `run` render the task, launch
through the gated launcher, `recordRun(launched|blocked|failed)`, `markRan` (advance `next_run_at` via
`computeNextRun`). `runAutomation(automation, trigger)` is shared by the tick, the manual run-now
route, and the webhook route.

Production wiring (`automations/default.ts`): binds the real repo, the `ventureGatedSubagentLauncher`
(reused from #123 `marketing/default.ts`), `getPersonaByHandle`, `resolveAutomationCaps(loadConfig…)`,
the #17 kill switch, the #99 maintenance flag. Default-OFF: `automations.enabled` + a default-0
`AUTOMATIONS_INTERVAL_MS`. Webhook tokens are generated with `node:crypto` and only the sha-256 hash
is stored (the token is shown once at create, like an API key).

### Task template gallery (no migration)

`GET /workspaces/:wid/task-templates?channel=:cid` returns the templates for the channel's #123
department (resolved from the channel name). The web composer renders a "Templates" affordance that
pre-fills the textarea with `@handle <rendered task>` — reusing the existing submit path (so picking a
template and sending launches the department agent exactly like a hand-typed @mention).

### Audit trail (no migration — read model)

`audit/normalize.ts` — pure `normalizeAuditEvents(input): AuditEvent[]`: merges three already-recorded,
tenant-scoped sources into one time-sorted feed — approval requests (`who` requested `what` action,
`gatedBy: "approval"`, the human gate), automation runs (`gatedBy: "venture+budget"`), marketing-task
launches (an agent launched in a channel). Each `AuditEvent` = `{ at, kind, actorMemberId, actorLabel,
summary, gatedBy, status, ref }`. `audit/service.ts` reads the three repos (each filters
`workspace_id`) + resolves member display labels; `GET /workspaces/:wid/audit` returns the capped feed.

### Live mission control (no migration)

`mission-control/build.ts` — pure `buildMissionControl({ sessions, rateCentsPerMinute, now })`: for
each live session derive `elapsedMs = now - progressAt-anchor` (uses `createdAt`/`startedAt`) and
`estimatedCostCents = ceil(elapsedMinutes) × rate`, plus a fleet roll-up (count, total estimated
spend). `mission-control/service.ts` reads a new workspace-scoped `listWorkspaceLiveSessions` +
`resolveScaleCaps(loadConfig).computeRateCentsPerMinute`; `GET /workspaces/:wid/mission-control`
returns the live list. Controls: `POST …/mission-control/sessions/:id/stop` → `SessionManager.cancel`,
`POST …/mission-control/sessions/:id/steer` → records a steer message + `SessionManager.steer` (the
#53 seam). Both are tenant-scoped (the session must belong to `:wid`).

## Config (default-OFF, the five sites)

One `automations` block — `config/schema.ts` (zod `automationsSchema` + `settingsSchema` field +
`AutomationsConfig` type + `ResolvedConfig` field + `CONFIG_DEFAULTS.automations`), `config/layers.ts`
(`mergeSettings` replace + `mergeLayers` default), `automations/caps.ts` resolver, `env.ts`
(`AutomationsEnv.intervalMs` + `AUTOMATIONS_INTERVAL_MS`, default 0). Audit + mission-control are
read-only viewers (no spend, no sends) gated only by the #19 `assertWorkspace` tenant boundary — no
config flag needed.

## Testing

- **Unit** (`test/unit/automations-pure.test.ts`, `audit-pure.test.ts`, `mission-control-pure.test.ts`):
  `computeNextRun` across all cadences + DST-free UTC edges; `isDue`; `decideAutomationRun` route
  ladder; `renderTemplate` placeholder substitution + every template resolves; `resolveAutomationCaps`
  defaults-OFF; `normalizeAuditEvents` merge + sort + cap; `buildMissionControl` elapsed + cost +
  rollup; empty inputs.
- **Integration** (`test/integration/automations.test.ts`): real repos + a **fake launcher** returning
  `newId()` (no model spend). Proves: create/list/toggle persistence + tenant isolation; a forced-ON,
  due automation `tickWorkspace` launches through the gated path and writes a `launched` run with the
  session id; a disabled automation is a no-op; the rate cap forces `skipped`; manual run-now and the
  webhook-by-token path both record runs; the audit feed surfaces the run + an approval request; the
  mission-control route lists a live session with a derived elapsed/cost and stop cancels it.

## Acceptance criteria

- [ ] Owners can declare scheduled/webhook automations; a default-OFF tick launches due ones through
      the #123 path with #96/#71 gating and #13-gated external sends; per-tenant run caps enforced.
- [ ] Six per-department task templates pickable from the channel composer; one registry shared with
      automations.
- [ ] An append-only, tenant-scoped audit pane shows who/what/when/gated-by over existing rows.
- [ ] A live mission-control pane lists running sessions (status/elapsed/spend) with steer + stop.
- [ ] Default-OFF, tenant-scoped, pure modules + seams, migration `0147`, spec + ADR, one PR.
