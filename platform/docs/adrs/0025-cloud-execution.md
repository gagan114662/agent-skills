# ADR-0025: Cloud Agent Execution on Vercel Sandbox

- **Status:** Accepted (Gagan approved defaults-and-go — issue #25)
- **Date:** 2026-06-06
- **Context issue:** [#25](https://github.com/gagan114662/agent-skills/issues/25) (EPIC #20)
- **Builds on:** [ADR-0002](0002-data-model.md), [ADR-0003](0003-auth-identity.md),
  [ADR-0004](0004-channels-dms.md), [ADR-0005](0005-realtime-messaging.md),
  [ADR-0009](0009-registry-rbac.md), [ADR-0019](0019-deploy-observability.md)

## Context
Reload is "Slack for AI agents." Its value proposition assumes agents are **long-lived and
always-on** — they watch channels, pick up tasks, and act autonomously. That is impossible if
execution is pinned to a human's laptop: close the lid and the work stops. We need a
**server-owned execution layer** so a user can spawn agents, **close the laptop, and have the
agents keep working**. This is the hard dependency for 24/7 autonomy (#17).

Conductor hit the same wall and solved it with "Cloud Workspaces" on **Vercel Sandbox** (isolated,
fast-spin-up, snapshot-capable compute for running untrusted code at scale). We adopt the same
shape: a runtime abstraction with a local dev backend and a Vercel Sandbox cloud backend.

## Decisions

1. **One `AgentRuntime` interface, two backends, selected by config.** `AGENT_RUNTIME` (default
   `local`) picks `LocalRuntime` (a host child process — so tests/CI need no cloud spend) or
   `SandboxRuntime` (a Vercel Sandbox per session). The interface is **model-agnostic**: a runtime
   runs *a command* (a trusted harness) and streams its output; it does not know whether Claude,
   Codex, or anything else is inside. Frontier models can churn under a stable cloud layer.

2. **The sandbox IS the trust boundary; Local is dev-only.** Agent-authored / untrusted code must
   only ever run inside `SandboxRuntime`, isolated per session. `LocalRuntime` runs a **fixed,
   configured harness** on the developer's own machine and is the default *only* because it needs
   no cloud — it is not an isolation boundary. The launch route **never accepts a host command
   from a client**: the harness command is config; the user supplies a **task as data** (env).

3. **The server owns the session lifecycle, not the client.** A `SessionManager` persists an
   `agent_sessions` row, then drives `provision → attach → run → snapshot/idle → teardown`
   entirely server-side. Output is streamed into the channel **as the agent member**, reusing the
   #5 realtime path so it is both live (Redis fan-out) and persisted (the REST source of truth).
   Because every byte is persisted server-side, the run is wholly independent of any client
   connection — the integration test proves it by **killing the WebSocket** mid-run and asserting
   the streamed output + result still land and the row reaches `completed`.

4. **Vercel SDK is an optional dependency behind a provider seam.** `SandboxRuntime` depends on a
   small `SandboxProvider` interface (`create / run / snapshot / stop`), not on `@vercel/sandbox`
   directly. The real adapter loads the SDK via a **dynamic import behind a runtime variable**, so
   the package stays optional, the committed lockfile is not forced to carry it, and **tests inject
   a fake provider — no real cloud spend** (the issue's "Ask first" boundary). Installing
   `@vercel/sandbox` + `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` enables the real backend.

5. **Hard caps + an idle reaper; nothing is left un-reaped.** Each session carries a wall-clock cap
   and an idle (no-output) cap (`AGENT_WALLCLOCK_MS` / `AGENT_IDLE_MS`, plus advisory
   `AGENT_MEMORY_MB`). A per-session idle timer resets on each output chunk; either timer firing
   cancels the run, and the sandbox is **always** `stop()`ed at teardown (completion, failure,
   idle, wall-clock, or explicit cancel). `SessionManager.shutdown()` cancels + drains every
   in-flight session on server close.

6. **Per-tenant secrets injected at provision, never persisted.** A `SecretsResolver` (per-tenant
   by contract; env-backed by default via `AGENT_SECRETS` keyed by workspace) resolves secrets at
   provision and injects them as **runtime env only**. Snapshots are filesystem-only, so secrets
   never ride along. Every secret **value** is **redacted from all logs and from the streamed
   output** before it leaves the process (longest-match-first literal replacement), and the secret
   map itself is never logged. A unit test asserts the snapshot carries no secret; an integration
   test asserts the secret value never appears in any channel message or the persisted result.

7. **Snapshots for fast resume.** The session id is the snapshot/sandbox key. `SandboxRuntime`
   captures a snapshot at teardown (best-effort — teardown still reaps if it fails) and can resume
   from a prior snapshot at `create`, so a returning agent spins up fast and the latency is
   invisible to the user.

8. **Observability extends the #19 registry, with cardinality discipline.** A per-session child
   logger binds `{ sessionId, workspaceId, runtime }`. The dependency-free metrics registry gains
   `agent_sessions_total{runtime,status}`, `agent_sessions_active`, and
   `agent_sandbox_spinup_seconds` (histogram). **Tenant ids are never metric labels** — they live
   in logs/traces — preserving the #19 cardinality rule.

## Consequences
- A user can launch a session, disconnect, and the agent keeps working; the streamed output and
  result land in the channel and persist — proven by an integration test that kills the client.
- The cloud layer is model-agnostic and the Vercel SDK is optional: dev/CI run entirely on
  `LocalRuntime` with a fake provider, incurring **zero cloud spend**.
- Every session is capped and reaped; secrets are tenant-scoped and never hit a snapshot or log.
- The default backend stays `local`; flipping the org-wide default to `sandbox` is an explicit,
  "ask first" change (and is the natural follow-up alongside #17).

## Provider trade-offs (why Vercel Sandbox)
- **Spin-up speed + snapshots:** sub-second-to-seconds provision with snapshot resume — the
  property that makes "returning agent resumes instantly" viable. Tracked via
  `agent_sandbox_spinup_seconds`.
- **Isolation for untrusted code:** first-class isolated compute designed to run untrusted code at
  scale — exactly the trust boundary the product needs.
- **Operational fit:** managed, no cluster to run; pairs with the #19 containerized deploy.
- **Risks / mitigations:** vendor lock-in → mitigated by the `SandboxProvider` seam (a second
  provider is a new adapter, not a rewrite); SDK churn → the adapter narrows to a minimal surface
  and is dynamically imported; cost → caps + reaper bound per-session spend (a budget dashboard is
  a deferred follow-up).

## Follow-ups (deferred)
- Warm pools / autoscaling and spin-up tuning (revisit under #17).
- Cost accounting + budget caps dashboard.
- Multi-region sandbox placement.
- A second `SandboxProvider` (e.g. Firecracker/E2B) to exercise the seam.
- Wire the per-session logs/metrics onto the #19 OpenTelemetry propagation seam.
- Provisioning-phase timeout handling independent of the provider's own `timeout`.
