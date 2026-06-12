# Spec: Reload Platform — Founder Briefings: the company reports to its owner (Issue #173)

> Implements [#173](https://github.com/gagan114662/agent-skills/issues/173). Phase — the company runs
> itself **and tells the owner what it did**. **Builds on #104** (the read-only Founder Console pattern:
> pure aggregate + IO orchestrator with one reader seam per source + `default.ts` wiring over existing
> repos + a thin tenant-scoped route) and **#148** (owner delivery: the email-first `PagerTransport`
> seam + `getWorkspaceOwnerContact`). Reuses **#98** (revenue), **#71** (`tenant_usage` spend),
> **#107** (per-venture P&L + kill/scale recommendations), **#96** (venture scorecards + movement),
> **#114** (customer-voice signals), **#115** (next-week backlog), **#146** (constitution / pricing
> violations), **#172** (build-loop ship + guardrail escalations), **#13** (the approval queue), and
> **#170** (the Slack owner-DM authority — now merged in main, so the brief DMs the owner via the same
> `sendOwnerDm` the Slack digest uses). The Slack channel stays a seam (no-op for any workspace that
> hasn't connected Slack). Lifecycle: DEFINE → atomic plan → TDD → ADR → one PR. **Video gate waived by the owner.**

## Objective

**What:** The owner directive — *they should never have to poll the app or this chat to know what their
company is doing; the company reports UP.* Today every number the owner needs already exists (revenue,
spend, ventures, approvals, ships, voice, backlog) but it is scattered across subsystems and only
visible on a pull. This feature makes the company **push** three things to the owner:

1. **Daily brief** (config-gated, delivered via the #148 notification seam, and the #170 Slack DM when
   connected): what every agent shipped, what is blocked, approvals waiting (with one-tap links), spend
   vs budget, any constitution violations flagged. Brand voice, **under 200 words**.
2. **Weekly founder report**: per-venture **P&L snapshot** (revenue #98, cost #71 + infra estimate,
   margin), venture **scorecard movement** (#96), **kill/scale recommendations** (#107), top
   **customer-voice signals** (#114), next week's **planned backlog** (#115). **Rendered in the Founder
   Console AND delivered as a digest.**
3. **Decision queue discipline**: everything requiring the owner — approvals (#13), guardrail
   escalations (#172), pricing/constitution proposals (#146) — appears in **ONE ordered queue** with
   **age + impact**; stale decisions **re-notify on an escalation schedule** (their escalation level
   rises with age and is re-surfaced in every daily brief), so a decision can **never silently rot**.

**Why now:** the autonomy stack (the loops above) is live. The missing piece is the reporting line — the
"company → owner" feedback loop that lets the owner step back from the keyboard. This is pure
composition over data that already exists; it adds **no new authority** over any business-domain table.

## Non-goals

- **No new mutation authority.** Briefings only *read* the business domain. The one thing they write is
  their **own delivery audit** (`founder_briefings`) — the idempotency watermark + send log, exactly as
  #148 `PagerService` always audits to `reliability_pages`. Approvals are still approved, ventures still
  killed, prices still set, through their existing endpoints — never here.
- **No per-venture revenue attribution.** Billing revenue (#98) is workspace-level; there is no
  per-venture split (see ADR-0107). The weekly P&L surfaces the #107 portfolio review numbers
  (`revenueCents / monthlyCostCents / netCents`) where a launched venture has a review, and falls back
  to "—" for ventures without one. The limitation is stated, not papered over.
- **Slack is a channel, not a dependency.** #170 is merged; the brief DMs the owner via the live
  `SlackEventService.sendOwnerDm` (the same authority the #170 digest uses). For a workspace that hasn't
  connected Slack — or in tests/CI where no Slack service is injected — the channel resolves
  `{ delivered:false, not_connected }` and email remains the always-available channel.

## Design

Mirrors #104 end-to-end: **pure aggregate** (`aggregate.ts`) + **IO orchestrator** (`service.ts`, one
reader seam per source) + **prod wiring** (`default.ts`) + **thin route** (`routes/founder-briefings.ts`)
+ **caps** (`caps.ts`, default OFF) + a **scheduled engine** (`engine.ts`, opt-in timer) + a tiny
**delivery audit store** (`db/repositories/founder-briefings.ts`, migration 0173).

### Pure core (`founder-briefings/aggregate.ts`) — all unit-tested

Three total functions, no IO, clock passed in:

- `composeDailyBrief(input): DailyBrief` — reshapes already-gathered structs (shipped items, blocked
  items, the owner-facing decision items, spend/budget, constitution counts) into the brief view **and**
  renders the brand-voice text. The renderer is **word-budgeted**: it emits the highest-signal lines
  first and is guaranteed `wordCount(text) <= maxWords` (default 200) — a unit test asserts the bound on
  a maxed-out input.
- `composeWeeklyReport(input): WeeklyReport` — per-venture P&L rows (`revenue/cost/net/marginPct`,
  `decision` = the #107 kill/scale rec, `scoreDelta` = #96 scorecard movement), the top voice signals,
  the ranked next-week backlog, and the rendered digest text.
- `composeDecisionQueue(input): DecisionQueue` — merges normalized `DecisionItem`s from all sources into
  ONE queue, computes `ageSeconds` + `escalationLevel(age)` per item, and orders by **impact desc, then
  oldest-first** (the longest-waiting high-impact decision is the bottleneck). Pure ⇒ the route, the
  daily brief, and the weekly digest all read the SAME ordering.

`escalationLevel` is a pure function of age against the caps thresholds (`[level1Hours, level2Hours,
level3Hours]`): 0 = fresh, rising to 3 = critically stale. Because every daily brief re-surfaces the
queue with each item's *current* level, a stale decision is re-notified on a rising schedule with no
per-item watermark needed — "never silently rot" falls out of the daily cadence.

### IO orchestrator (`service.ts`)

`FounderBriefingsService` declares one reader seam per source (`ShipReader`, `BlockReader`,
`ApprovalsReader`, `SpendReader`, `ConstitutionReader`, `VentureReader`, `PortfolioReader`,
`VoiceReader`, `BacklogReader`, `RevenueReader`) + a `BriefingNotifier` delivery seam + a
`DeliveryStore` (the audit/idempotency seam) + an injectable clock. Public methods:

- `dailyBrief(wid)` / `weeklyReport(wid)` / `decisionQueue(wid)` — gather (`Promise.all`) → pure compose.
  Read-only; used by the route + the Founder Console pane.
- `deliverDaily(wid, periodKey)` / `deliverWeekly(wid, periodKey)` — gate on caps + the **idempotency
  watermark** (`DeliveryStore.wasDelivered` → skip if already sent this period), render, deliver through
  the notifier (email + optional Slack), and **always record** the attempt (delivered or skipped) to the
  audit store.

### Delivery (`notifier.ts`)

`BriefingNotifier.deliver({ workspaceId, kind, subject, body })` → `{ channels: ChannelResult[] }`. The
default `MultiChannelBriefingNotifier`:

- resolves the owner via `getWorkspaceOwnerContact` (#148) and sends the digest through the email-first
  `PagerTransport` (the #148 transport — `LogPagerTransport` in CI/privacy mode, `EmailPagerTransport`
  when SMTP is configured and egress is allowed);
- ALSO sends through an injected `SlackDeliverer`. In production `default.ts` adapts the live #170
  `SlackEventService` (`slackBriefingDeliverer` → `sendOwnerDm`); a workspace with no Slack connection
  resolves `{ channel: "slack", delivered: false, reason: "not_connected" }`. With no Slack service
  injected (CI/tests) the channel is the `NoopSlackDeliverer`.

A no-owner workspace (all-agent fixture) is audited `no_owner` and dropped — never throws.

### Scheduled engine (`engine.ts`)

`FounderBriefingsEngine` mirrors the watchdog/SRE supervisor: `start(intervalMs)` / `stop()` (default
interval `0` = OFF, started in `index.ts` only when `BRIEFINGS_INTERVAL_MS > 0`), and `tickAll()` which
(after a #99 maintenance-pause check) iterates `listWorkspaceIds()`, computes the **daily period key**
(`YYYY-MM-DD` UTC) and **weekly period key** (`YYYY-Www` ISO week) for `now`, and calls
`deliverDaily` / `deliverWeekly` — each a no-op when already sent for that period (the watermark) or when
the caps flag is off. `tickWorkspace(wid, now)` is exposed so tests drive delivery deterministically with
no timer.

### Route (`routes/founder-briefings.ts`)

Three READ-ONLY, tenant-scoped (`requireIdentity` + `assertWorkspace`, the #19 guard) endpoints under the
Founder Console namespace, consumed by the console pane:

- `GET /workspaces/:wid/founder-briefings/daily`
- `GET /workspaces/:wid/founder-briefings/weekly`
- `GET /workspaces/:wid/founder-briefings/decision-queue`

No mutation endpoints — delivery is driven by the engine/tick, not a request.

### Config (`caps.ts` + the layered #58 config)

`briefings` is a new **default-OFF** config block (`resolveBriefingsCaps`): `enabled` (master gate for
delivery + the tick), `daily` / `weekly` (per-digest toggles, default on *when* enabled), the three
escalation-age thresholds, `digestVoiceLimit`, `backlogLimit`, `maxBriefWords` (200). Registered in all
the standard sites (schema ×3, `mergeSettings`, `mergeLayers`, optional `RELOAD_BRIEFINGS_ENABLED` env
opt-in). Reads stay always-available (the route renders the brief regardless); only *delivery* + the tick
are gated, so an un-opted-in deployment is byte-for-byte unchanged.

### Persistence (migration 0173)

ONE table — the delivery audit / idempotency watermark, numbered **by issue** (0173, per ADR-0099):

```
founder_briefings (
  id uuid pk,
  workspace_id uuid not null references workspaces(id) on delete cascade,  -- #3 tenant boundary
  kind text not null check (kind in ('daily','weekly')),
  period_key text not null,        -- 'YYYY-MM-DD' (daily) | 'YYYY-Www' (weekly)
  delivered boolean not null,
  channels jsonb not null default '[]',  -- per-channel delivery results (audit)
  word_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (workspace_id, kind, period_key)  -- the idempotency watermark
)
```

The `UNIQUE (workspace_id, kind, period_key)` is the watermark: a second tick in the same period inserts
nothing (`onConflictDoNothing`) and `wasDelivered` short-circuits the send.

## House-rules checklist

- **Approval gates intact** — briefings never approve/kill/price; they *surface* the queue. ✅
- **Tenant scoping** — every reader + the route is `workspace_id`-scoped (#3); the route asserts the
  caller's workspace (#19). ✅
- **Migrations numbered by issue** — `0173_founder_briefings.sql` (+ `.down.sql`). ✅
- **Tests** — all three pure composers + caps + the multi-channel notifier + the engine watermark are
  unit-tested; one integration test exercises the route + delivery idempotency through the real DB. ✅
- **No secrets in code** — SMTP/Slack credentials stay on the secrets/transport seam; config holds names
  and flags only. ✅
- **Default-OFF** — `briefings.enabled` defaults false; `BRIEFINGS_INTERVAL_MS` defaults 0. ✅
```
