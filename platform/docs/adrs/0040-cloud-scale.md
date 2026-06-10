# ADR-0040: Cloud Scale — Warm Pools, Autoscaling, Multi-Region, Cost Caps

- **Status:** Accepted (Gagan approves on the demo video — issue #71)
- **Date:** 2026-06-09
- **Context issue:** [#71](https://github.com/gagan114662/agent-skills/issues/71) (Phase 5 — hardening & scale · part of EPIC #60)
- **Builds on:** [ADR-0017](0017-autonomy.md) (kill switch + guards),
  [ADR-0019](0019-deploy-observability.md) (metrics), [ADR-0025](0025-cloud-execution.md)
  (AgentRuntime / SessionManager / SandboxProvider), [ADR-0035](0035-config-layering.md)
  (managed/per-tenant config). Out of scope: the e2e correctness proof (that is #37).

## Context
#25 gave us cloud *execution*: a session runs server-side on an `AgentRuntime`, snapshots its
filesystem at teardown, and streams into a channel. But it **cold-provisions every session**, has
**no ceiling on concurrent spend**, runs in a **single region**, and has **no per-tenant cost
budget**. The #17 kill switch halts the autonomy loop but **not** ad-hoc launches. These are exactly
the scale levers Conductor tuned and #25 deferred — needed before running a real fleet 24/7. This
ADR adds four levers on top of #25, each behind the same kind of seam #25 used so **CI/dev incur
zero cloud spend**.

## Decisions

1. **A single admission chokepoint in `SessionManager.launch`.** Every launch path (REST, Team Mode,
   autonomy, subagents, turns, run, integrations) already funnels through `SessionManager.launch`,
   so admission lives there and governs the whole fleet without touching each call site. `Admission`
   is an **optional dep** (like `workspace`/`tracer`): unset → today's behavior. It checks, in
   order, **kill switch (#17) → budget → per-tenant concurrency → global concurrency**, and on a
   denial `launch` **throws before any row is created** (the route maps it to 429/402). The order is
   deliberate: a hard stop precedes the soft caps.

2. **Pure decision, IO orchestrator** (the #17 pattern). `scale/decide.ts` (admission priority),
   `scale/region.ts` (placement), `scale/usage.ts` (cost/window math), `scale/caps.ts` (config →
   caps) are **pure and DB-free**, unit-tested in isolation. `scale/admission.ts` holds the
   in-memory counters + the seams (usage reader, kill-switch reader, tenant config) and calls the
   pure deciders. A granted launch returns a **ticket** whose `release()` frees the slot at teardown
   on **every** path (success, failure, reap, cancel) — so a crashed session never permanently
   consumes a tenant's concurrency.

3. **The warm pool injects secrets only at bind — never into a pooled instance.** A
   `PrewarmedSandbox` pays the slow cost (microVM boot + base image) ahead of demand with **no
   tenant secrets and no task**; `bind(env, secrets)` produces a tenant-specific, short-lived
   `SandboxInstance`. `WarmPool` **decorates** a `SandboxProvider` and itself `implements
   SandboxProvider`, so it slots transparently in front of `SandboxRuntime`. A `snapshotId` resume
   bypasses the pool; an empty buffer cold-creates; the buffer refills in the background, per region.
   With `warmPoolSize = 0` (default) it is a pass-through (cold) — unchanged #25 behavior. **The
   real `WarmableSandboxProvider.prewarm` (live microVM prewarm) is a documented follow-up behind
   the seam** — the mechanism + tests ship now with zero cloud spend, exactly as #25 left real
   Vercel calls behind a provider.

4. **Caps are policy (config); usage is state (DB).** Operators set caps in the managed (optionally
   per-tenant, #58) `[scale]` block — `warmPoolSize`, `regions`, `tenantConcurrency`,
   `globalConcurrency`, `budgetCents`, `computeRateCentsPerMinute` — all **non-secret** and all
   **off by default**. `tenant_usage` accumulates runtime consumption per (tenant, UTC-month
   window). Admission compares the two. Separating them lets an operator **raise a budget without a
   migration**. Cost is an **estimate** (compute-seconds × rate); real billing is out of scope.

5. **Least-loaded multi-region placement.** `planRegion(allowed, loadByRegion, preferred)` picks the
   least-loaded allowed region (ties → preference order → name); the choice flows through
   `SandboxCreateOpts.region`, drives per-region warm buffers, and is **persisted on
   `agent_sessions.region`** for audit. An empty allowed list = unplaced (single-region #25 default).

6. **The #17 kill switch now halts ALL launches, not just the autonomy tick.** Admission reads the
   existing `autonomy_controls.kill_switch`; engaging it denies every launch for that tenant
   immediately (429). This is the "on-call can hard-stop a tenant instantly" lever the issue calls
   for — reusing existing authority, no new switch.

7. **Observability extends the #19 dependency-free registry, with the same cardinality discipline.**
   `scale_warm_hits_total` / `scale_warm_misses_total`, `scale_admission_denied_total{reason}`,
   `scale_region_sessions_total{region}` — **no tenant labels** (they live in logs/traces). The
   warm-vs-cold latency win is also visible in the existing `agent_sandbox_spinup_seconds`. A
   tenant-scoped `GET /workspaces/:wid/scale/usage` + a web Usage dashboard surface the numbers.

## Consequences
- A launch is admitted up to per-tenant + global caps; a breach is a clean 429 and a budget breach a
  402, **never a silent overspend** — proven by unit + integration tests.
- The warm pool serves launches via a fast bind path that excludes the cold-provision cost from the
  critical path; secrets are bound only at claim — proven hermetically with a fake provider.
- A tenant budget halts new sessions and the dashboard/endpoint surfaces it — proven end to end.
- Dev/CI run with the pool off, caps off, and no cloud transport loaded: **zero cloud spend**,
  consistent with the #25 boundary. Wiring admission+usage on by default is behavior-neutral (all
  caps 0 = admit-all) while enabling the kill-switch-halts-launch + usage levers immediately.

## Hardening note (`security-and-hardening`)
- **Cap-bypass paths:** admission is the single chokepoint in `launch`; every internal launcher goes
  through it. The slot is released on *every* teardown path, so caps can't be starved by crashed
  sessions. The pure decider makes the priority order auditable and test-pinned.
- **Cost blast-radius:** budget is per-tenant per-window; the kill switch is the hard stop. Cost
  defaults to 0 (rate 0) so a misconfiguration can't *create* spend — it can only *cap* it.
- **Secret handling:** a pooled/prewarmed sandbox never holds a tenant secret (the `prewarm` seam
  has no secrets channel by construction); secrets are injected only at bind, never logged, and the
  #25 redaction is unchanged. A denied launch's error is content-free (`{ error, reason }`).
- **Tenant isolation:** usage + the dashboard are tenant-scoped via the #19 guard
  (`assertWorkspace` → 403 cross-tenant); usage metrics carry no tenant labels.

## Follow-ups (deferred)
- A production `WarmableSandboxProvider` (real microVM prewarm + region pinning) behind the seam.
- A persistent/queued admission backlog (today a breach is rejected; internal launchers self-throttle).
- Cross-region snapshot replication / mid-run failover (today placement is at provision only).
- Real currency/billing integration (today cost is a compute-seconds × rate estimate).
- Process/replica fleet autoscaling (this ADR scales *session concurrency*, not the Node fleet).
