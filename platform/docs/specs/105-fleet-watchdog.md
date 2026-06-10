# Spec: Reload Platform — Fleet Watchdog: detect, revive, and escalate stalled agent sessions (Issue #105)

> Implements [#105](https://github.com/gagan114662/agent-skills/issues/105). Phase 5 — hardening &
> observability for the 24/7 fleet. **Builds on #25** (`SessionManager`, `agent_sessions` lifecycle),
> **#84/#92** (real agent sessions / `AutonomyLauncher` seam), **#17/#80** (pure `decide`/`guards` +
> IO orchestrator; kill switch), **#71** (`tenant_usage` dollar accounting), **#99** (maintenance
> Redis flag), and **#13** (governance approvals queue). Lifecycle: **DEFINE** artifact
> (`spec-driven-development`) → atomic plan → TDD failing-first → ADR → one PR. **Video gate waived by
> the owner.**

## Objective

**What:** A supervisor — the **Fleet Watchdog** — that runs on infrastructure time and makes the
24/7 fleet self-healing. Today a network blip can kill an agent process mid-task, leaving its
`agent_sessions` row stuck at `running`/`provisioning` with no live reaper (the in-process wall-clock
/ idle timers died with the process). A human has to notice and retry. The watchdog removes the human
from that loop:

1. **Heartbeats + stall detection** — every agent session emits a progress heartbeat (the
   `SessionManager` bumps `agent_sessions.last_heartbeat_at` on every output chunk — the same liveness
   signal the #25 idle-reaper already trusts). A periodic **watchdog tick** (default OFF) flags any
   non-terminal session whose last heartbeat is older than a configured `staleCutoffMs`.
2. **Bounded revival with backoff** — a stalled session is **revived** (a replacement session is
   launched for the same channel/agent through the #92 `AutonomyLauncher`, so the #70 worktree / #51
   branch is reused — resume, not a cold restart) under a **bounded restart policy**: a minimum
   **backoff** between revivals, a **max revivals per rolling window**, and **dollar-awareness** (a
   workspace at/over its #71 `tenant_usage` budget never spends more on revivals).
3. **Repeated death ≠ transient blip** — the revival count is **durable** (`watchdog_revivals`),
   so the bound survives a process restart and the loop can never retry forever. Once the per-window
   limit is reached — or a **non-retryable** failure class is seen — the watchdog **escalates** to the
   **#13 approvals queue / Founder Console** instead of reviving again.
4. **Failure taxonomy persisted** — each revival record records the dead session's terminal status as
   a failure class (`stalled`, `timeout`, `connection`, …) with a pure `retryable` classification, so
   the watchdog learns which errors are worth reviving and which go straight to a human.
5. **Deep observability** — tick + revival + escalation counters feed the #19 metrics registry; the
   #25 session span (Braintrust, no-op unless keyed) already carries the per-session trace this hangs
   off of.

**The pure core (the testable gate):** `decideRevival(input) → { action: "revive" | "escalate" |
"wait" | "noop"; reason }`. Like #17 `decideWorkflowAction` and #96 `decideVenture`, it is pure and
unit-tested for every branch; the engine does the side effects (finalize the dead row, launch the
replacement, write the revival record, enqueue the escalation).

**Why:** "Premortem #6 — today's session proved it: network blips killed agents mid-task and a HUMAN
had to notice and retry." A 24/7 fleet must detect, retry within bounds, and escalate on its own,
without ever silently dropping work or retrying forever.

**Who:** Operators of the autonomous fleet (the watchdog removes the manual retry); a founder (Gagan)
who wants repeated/unrevivable failures escalated for judgment rather than silently abandoned or
spun on forever; the autonomy engine, whose launched sessions are the ones being supervised.

## Default OFF (unchanged behavior)

The watchdog is **doubly opt-in**, exactly like the #17 autonomy loop and #96 venture tick:

- `WATCHDOG_INTERVAL_MS` defaults to `0` → the background timer never starts (tests drive `tick()`).
- `watchdog.enabled` config defaults to `false` → even a manually-driven tick short-circuits per
  workspace (no detection, no revival) until an operator opts in.

A deployment that sets neither keeps today's #25 behavior precisely: the only always-on addition is a
single `last_heartbeat_at` write per output chunk (one indexed column update; no new network call).

## Acceptance criteria (from #105 — BUILD/TDD)

1. **Pure `decideRevival` yields every action from staleness + policy + guards** — `noop`
   (kill switch, or not yet stale), `escalate` (revival limit reached, non-retryable class, or budget
   exhausted), `wait` (stale but inside the backoff window), `revive` (stale, retryable, under the
   limit, past backoff, budget OK). Order is deliberate (hard stops first), proven by unit tests.
2. **Bounded restart policy** — pure guards (`isStale`, `revivalLimitReached`, `backoffElapsed`,
   `windowExpired`) compose the bound; a rolling window resets the count; revivals never exceed
   `maxRevivalsPerWindow`. Proven by unit tests.
3. **Failure taxonomy** — `classifyFailure(status, exitCode)` maps a terminal status to a class +
   `retryable` flag; a non-retryable class escalates on the first detection (no infinite retry on a
   permanently-broken session). Proven by unit tests.
4. **Kill switch + maintenance gate the tick** — `tickAll()` skips entirely when the #99 maintenance
   flag is active (BEFORE any DB call); a workspace pass returns immediately when its #17 kill switch
   is engaged. Proven by a unit test asserting the lister/repo is never called.
5. **Dollar-aware** — a workspace whose #71 `tenant_usage` estimated cost has met/passed its
   configured budget escalates instead of reviving (no extra spend). Reuses the same accounting that
   bounds sessions and ventures. Proven by a unit test.
6. **#92 launcher integration + #13 escalation, on real Postgres** — an integration test seeds a
   `running` `agent_sessions` row with a stale heartbeat in an isolated workspace, runs the watchdog
   tick, and asserts: the dead row is finalized, a replacement session is launched via the
   `AutonomyLauncher`, a durable `watchdog_revivals` row records the attempt; and after the per-window
   limit is exceeded a `watchdog.escalate` request lands in the #13 `approval_requests` queue.
   **Per-workspace isolation**: a stale session in workspace A never triggers action in workspace B.
7. **No weakened existing tests** — the `SessionStore.heartbeat` seam is optional so every existing
   fake store still satisfies it; the heartbeat column is additive; the whole feature is default-OFF.

## Seams (pure decision + IO orchestrator)

```
src/watchdog/types.ts     shared types (LiveSession, RevivalRecord, WatchdogDecision)
src/watchdog/guards.ts    pure predicates (isStale, revivalLimitReached, backoffElapsed, windowExpired)
src/watchdog/taxonomy.ts  pure classifyFailure(status, exitCode) → { class, retryable }
src/watchdog/decide.ts    pure decideRevival(input) → { action, reason }   (kill→stale→taxonomy→limit→budget→backoff→revive)
src/watchdog/caps.ts      resolveWatchdogCaps(config.watchdog) → resolved caps (default OFF)
src/watchdog/engine.ts    WatchdogEngine: start/stop/tickAll/tickWorkspace — injected seams, maintenance+kill gate
src/watchdog/default.ts   createDefaultWatchdogEngine(logger, sessionManager) — real wiring over the repos
```

IO seams the engine drives (all injected; tests pass fakes):

- `listLiveSessions()` — non-terminal (`provisioning`/`running`) sessions across workspaces (the
  work-list; bounded by live concurrency, indexed on `status`).
- `caps(workspaceId)`, `killSwitch(workspaceId)`, `budgetExhausted(workspaceId, now)` — config + #17 +
  #71 reads, mirroring the venture wiring.
- `revivals` — the `watchdog_revivals` store (lineage lookup by current session, create, record a
  revival with rolling-window reset, mark escalated).
- `reviver` — the #92 `AutonomyLauncher` (reused verbatim) that launches the replacement session.
- `finalizeDead(sessionId, status)` — finalize the stalled row (reuses `finalizeSession`).
- `escalate` — `createRequest` into the #13 queue with `actionType: "watchdog.escalate"`.
- `maintenancePaused()` — the #99 `isMaintenanceActive` (fail-open).

## Out of scope (deferred behind seams, like #96)

- **Live-process resume of in-flight state.** "Revive" relaunches a replacement session for the same
  channel/agent (reusing the #70 worktree / #51 branch via the launcher). True checkpoint-and-resume
  of a partially-completed turn is a follow-up; the seam (`reviver`) is the place it plugs in.
- **Acting on already-terminal transient failures.** This slice detects **non-terminal stalls** (the
  premortem: a crashed driver leaves a `running` row with a dead reaper). Sweeping rows that already
  finalized as `failed` (e.g. an immediate ConnectionRefused) into the same policy reuses the same
  `decideRevival` + taxonomy and is a natural follow-up.
- **Per-tool-call child spans / retry-lineage spans in Braintrust.** The #25 session span and the
  durable `watchdog_revivals` lineage carry the retry story; richer child-span instrumentation rides
  the existing `AgentTracer` seam and is deferred (the no-op tracer keeps CI network-free).
