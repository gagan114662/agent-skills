# ADR-0105: Fleet Watchdog — detect, revive, and escalate stalled agent sessions

- **Status:** Accepted (shipped in PR for #105)
- **Date:** 2026-06-10
- **Context issue:** [#105](https://github.com/gagan114662/agent-skills/issues/105)
- **Spec:** [docs/specs/105-fleet-watchdog.md](../specs/105-fleet-watchdog.md)
- **Builds on:** [ADR-0025](0025-cloud-execution.md) (SessionManager / `agent_sessions`),
  [ADR-0017](0017-autonomy.md) (pure `decide`/`guards` + IO orchestrator; kill switch),
  [ADR-0042](0042-autonomy-auto-approve.md) / #84 (real sessions via the `AutonomyLauncher` seam),
  [ADR-0040](0040-cloud-scale.md) (`tenant_usage` dollar accounting), [ADR-0013](0013-approval-gates.md)
  (approvals queue), [ADR-0099](0099-disaster-recovery.md) (maintenance Redis flag).

> **Numbering note.** Spec/migration/ADR all use the `0105` slot (the issue number), per the
> project's by-issue numbering convention (see ADR-0099's note) — chosen to dodge sibling-workspace
> collisions in the shared migration sequence.

## Context

The platform can run agents 24/7 (#17/#84) but nothing supervises them once launched. The #25
`SessionManager` arms an **in-process** wall-clock + idle reaper, but that reaper is a `setTimeout` in
the driving process. **Premortem #6 proved the gap:** a network blip killed an agent process
mid-task; its `agent_sessions` row was left stuck at `running` with no live timer to reap it, and a
*human* had to notice and retry. A self-healing fleet needs a supervisor that lives **outside** any
single session's process, detects no-progress sessions durably, revives them within bounds, and
escalates when revival is hopeless — never silently dropping work and never retrying forever.

The hard parts are not "relaunch a session". They are: (a) a liveness signal that survives a crashed
driver (the in-process reaper cannot, by definition, reap the process it died with); (b) a restart
policy that is **bounded and durable** so a flapping session can't spin forever or reset its budget on
every restart; (c) telling a **transient** blip (revive) apart from a **permanent** break or a
**repeated** death (escalate to a human); (d) doing all of it **dollar-aware** and **default-OFF** so
it changes nothing until an operator opts in.

## Decisions

1. **Heartbeats are an additive column the SessionManager already has the signal for.**
   `agent_sessions.last_heartbeat_at` is bumped on every output chunk — the exact point the #25
   idle-reaper already calls `resetIdle()`, i.e. proven liveness. The write goes through a **new
   optional `SessionStore.heartbeat?(id)` seam**: optional so every existing fake store in the unit
   suite still satisfies the interface (no weakened tests), and a no-op when unwired. Staleness is
   `now − COALESCE(last_heartbeat_at, started_at, created_at)`, so rows predating the column (or never
   heartbeated) still get a sane age. This is the only always-on change, and it is one indexed-column
   update per chunk — no new network call.

2. **The watchdog tick is cross-process and runs on infrastructure time, gated like every other loop.**
   `WatchdogEngine.start(intervalMs)` is a no-op when `intervalMs ≤ 0` (default `0` = OFF), mirroring
   #17/#96. `tickAll()` checks the #99 maintenance flag **before any DB call** (fail-open) and skips
   the whole pass during a maintenance window; each per-workspace pass returns immediately when the
   #17 kill switch is engaged or when `watchdog.enabled` config is false. The work-list is
   `listLiveSessions()` (non-terminal sessions, indexed on `status`) grouped by workspace — naturally
   bounded by live concurrency, so we never scan history.

3. **The decision is pure; the engine does the side effects.** `decideRevival(input)` returns one of
   `revive | escalate | wait | noop` with a `reason`, in a deliberate hard-stops-first order
   (kill switch → not-stale → non-retryable class → revival-limit → budget → backoff → revive),
   exactly like `decideWorkflowAction`/`decideVenture`. Every branch is a unit test. The engine
   finalizes the dead row, launches the replacement, writes the revival record, or enqueues the
   escalation — the choice lives in `decide.ts`, the effects in `engine.ts`.

4. **The restart policy is bounded AND durable.** `watchdog_revivals` persists, per lineage, the
   revival count, a rolling window (`window_started_at`), the last revival time (backoff input), the
   replacement session (`current_session_id`, the lineage pointer), and the last failure class. The
   bound (`maxRevivalsPerWindow`) therefore survives a process restart — a crash can't reset a
   flapping session's budget. A new stall whose `current_session_id` matches an existing record
   continues that lineage; an unrecognized stall starts a fresh one. When the window has elapsed the
   count resets; when the limit is hit the watchdog **escalates instead of reviving**.

5. **Transient vs permanent vs repeated is explicit.** `classifyFailure(status, exitCode)` (pure) maps
   a terminal status to a `{ class, retryable }` taxonomy persisted on the revival record (so the
   watchdog "learns which errors are retryable"). A non-retryable class escalates on first detection;
   a retryable stall is revived up to the per-window limit, after which **repeated** death escalates.
   This is how "no-progress ≠ transient … never infinite retry" is enforced — by the durable bound and
   the taxonomy, not by hope.

6. **Revival reuses the #92 `AutonomyLauncher` seam verbatim.** "Revive" launches a replacement
   session for the same channel/agent through the same launcher the autonomy engine uses — so it
   passes the **same** #71 admission chokepoint (kill switch / budget / concurrency → 402/429) and,
   with the #70 worktree / #51 branch keyed off the channel+agent, resumes on the same branch rather
   than cold-restarting. The watchdog adds **no new launch authority**; it cannot launch anything the
   autonomy path couldn't.

7. **Dollar-awareness reuses the one tenant budget.** `budgetExhausted(workspaceId, now)` reads the
   same #71 `tenant_usage` estimated cost against the same `scale.budgetCents` cap that bounds
   sessions and ventures — so a workspace at its ceiling escalates to a human instead of spending more
   on revivals. One budget bounds launches, ventures, **and** revivals.

8. **Escalation is the #13 queue, not a new mechanism.** A hopeless lineage (limit hit, non-retryable,
   or out of budget) enqueues a `createRequest({ actionType: "watchdog.escalate", … })` into the
   existing `approval_requests` table — the Founder Console surface — and marks the lineage
   `escalated`. No new notification path; the dead row is finalized `failed` so it leaves the
   work-list.

## Consequences

- **Default-OFF, additive, no weakened tests.** Double opt-in (interval `0` + `enabled:false`), an
  optional heartbeat seam, an additive column, and a new table/migration (`0105`) with no change to
  existing schemas. Existing fakes and tests are untouched.
- **Bounded blast radius on a flap.** A flapping session can be revived at most `maxRevivalsPerWindow`
  times per `windowMs`, then it is a human's problem — by construction, durably.
- **Observability.** `watchdog_ticks_total` / `watchdog_actions_total{action}` join the #19 registry;
  the durable `watchdog_revivals` lineage is the retry story; the #25 session span (no-op unless
  Braintrust-keyed) carries the per-session trace.
- **Deferred (behind seams):** true checkpoint-resume of in-flight turn state, sweeping
  already-`failed` transient rows into the same policy, and per-tool-call child spans — each plugs
  into an existing seam (`reviver`, `decideRevival`, `AgentTracer`) without reshaping this slice.
