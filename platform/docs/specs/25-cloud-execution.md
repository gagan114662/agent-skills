# Spec: Reload Platform — Cloud Agent Execution on Vercel Sandbox (Issue #25)

> Implements [#25](https://github.com/gagan114662/agent-skills/issues/25). Part of EPIC #20.
> Depends on #19 (deploy/observability), #3 (auth/identity), #4/#5 (channels + realtime).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Built the agent_skills way —
> every stage governed by a skill in `skills/`.

## Objective
**What:** Add a **cloud execution backend** so Reload's agents run on remote, isolated
sandboxes instead of a developer's laptop — letting a user spawn a fleet of agents, **close
the laptop, and have the agents keep working**. Introduce an `AgentRuntime` abstraction with
two interchangeable backends: `LocalRuntime` (run a trusted harness as a host child process —
the default, so tests/CI need no cloud spend) and `SandboxRuntime` (provision a Vercel Sandbox
per agent session, stream output back, tear down on completion or idle).

**Why:** Reload is "Slack for AI agents." The whole value proposition assumes agents are
**long-lived and always-on** — they watch channels, pick up tasks, act autonomously. That is
impossible if execution is pinned to a human's laptop: close the lid and the work stops. A
**server-owned execution layer** is the hard dependency that makes 24/7 autonomy (#17) real.

**Who:** Humans who launch agent sessions into a channel and then disconnect; agents whose
work runs server-side and streams results back into the conversation; operators who must cap
resources, isolate tenants, and observe every session.

### Acceptance criteria (from #25)
1. `AgentRuntime` interface with `LocalRuntime` + `SandboxRuntime` implementations; backend
   selected by config/env (`AGENT_RUNTIME`, default `local`).
2. Spawn an agent session in a sandbox, **stream live output into the channel**, and persist
   the result — with the launching client disconnected the whole time.
3. Sandboxes are **per-session, isolated, reaped** on completion or idle timeout; resource +
   wall-clock caps enforced.
4. **Per-tenant secret injection at provision**; secrets never persisted in snapshots or logs.
5. Observability: structured logs + metrics per sandbox session (ties into #19).
6. Integration test: start a session, kill the client connection, assert the agent finishes
   and posts its result into the channel.
7. ADR documenting the runtime abstraction and the Vercel Sandbox decision.
8. Demo: spawn agent → close the lid → agent keeps working → result lands in the channel.

### In scope
- **Runtime abstraction** (`apps/server/src/runtime/`): one `AgentRuntime` interface, a
  `LocalRuntime` (host child process) and a `SandboxRuntime` (Vercel Sandbox via an injected
  `SandboxProvider`, so tests mock it with zero cloud spend).
- **Explicit lifecycle:** `provision → attach → run → snapshot/idle → teardown`, modelled as
  session status transitions and driven by the orchestrator.
- **Session orchestrator** (`SessionManager`): server-owned registry of running sessions. It
  provisions the runtime, streams output into the channel **as the agent member** (reusing the
  #5 realtime path so it is both live and persisted), enforces caps, reaps on completion/idle,
  and persists the terminal result — all independent of any client connection.
- **Caps + idle reaper:** per-session wall-clock timer + idle (no-output) timer; either fires →
  cancel + teardown. A periodic sweep is documented as a robustness backstop.
- **Per-tenant secrets:** a `SecretsResolver` resolves a workspace's secrets at provision and
  injects them as runtime env. Secrets are **redacted from all logs and streamed output** and
  are **never written into a snapshot**.
- **Persistence:** an `agent_sessions` table (migration `0025`) records runtime, status,
  sandbox/snapshot ids, caps, exit code, and a result tail — workspace/channel/agent scoped.
- **REST routes:** launch / get / list / cancel an agent session, gated by #9 channel
  capabilities and the #19 tenant guard.
- **Observability:** per-session child logger + metrics (`agent_sessions_total{runtime,status}`,
  `agent_sessions_active`, `agent_sandbox_spinup_seconds`) with bounded cardinality (no tenant
  labels — they live in logs).

### Out of scope (deferred / documented-not-automated)
- **Autoscaling / warm pools** (revisit under #17) — each session provisions on demand.
- **Cost controls / budget dashboard** — caps are enforced; spend accounting is a follow-up.
- **Multi-region sandbox placement** — single region; provider default.
- **A live hosted trace backend** — we emit structured logs + metrics on the #19 seam; the
  OpenTelemetry exporter remains the documented drop-in from #19.
- **Real Vercel Sandbox calls in CI** — the SDK adapter is behind a dynamic import and the
  `SandboxProvider` interface; CI/tests mock it (no real cloud spend, per the issue boundary).

## The runtime abstraction
```
AgentRuntime (kind: 'local' | 'sandbox')
  start(job, hooks) -> RunningSession
      job   : { sessionId, workspaceId, command, args, env, secrets, caps }
      hooks : { onOutput(stream, chunk), onStatus(status) }
  RunningSession: { wait(): Promise<RuntimeResult>, cancel(reason): Promise<void> }
  RuntimeResult: { status, exitCode, snapshotId? }
```
- **LocalRuntime** — `provision` spawns a **fixed, trusted harness command** (never arbitrary
  client input) as a child process; `attach` wires stdout/stderr to `onOutput`; `teardown`
  kills the process group on exit/cancel. Default backend so tests/CI need no cloud.
- **SandboxRuntime** — delegates to a `SandboxProvider`:
  `provision` = `provider.create({ sessionId, workspaceId, env, secrets, snapshotId?, caps })`;
  `attach/run` = `sandbox.run(command, args, onOutput)`; on terminal it takes a `snapshot()`
  (filesystem only — **secrets are env-injected, never written to disk**) then always `stop()`s
  the sandbox (reaped). The real Vercel adapter (`@vercel/sandbox`) is loaded via dynamic import
  so the dependency is optional and the test/CI path never touches it.

## Trust boundary (why two backends)
- **The sandbox IS the isolation boundary.** Agent-authored / untrusted code must only ever run
  inside `SandboxRuntime`, scoped per session, with no host filesystem/network beyond an
  allowlist. This is the production backend for multi-tenant untrusted execution.
- **`LocalRuntime` runs a trusted, configured harness on the developer's own machine** for
  dev/test. The launch route never accepts an arbitrary host command from a client — the harness
  command is fixed by config; the user supplies a **task/prompt as data** (env), not a command.

## Lifecycle & caps
```
provision  -> create child/sandbox, inject per-tenant secrets as env
attach     -> wire stdout/stderr -> channel (live + persisted)
run        -> agent works; idle timer resets on each output chunk
snapshot   -> (sandbox) capture filesystem snapshot for fast resume — NO secrets
idle/cap   -> wall-clock OR idle timeout fires -> cancel
teardown   -> kill/stop, persist terminal status + result, post final message, deregister
```
Caps come from env: `AGENT_WALLCLOCK_MS` (default 600000), `AGENT_IDLE_MS` (default 120000),
`AGENT_MEMORY_MB` (advisory, passed to the provider).

## Data model — `agent_sessions`
`id, workspace_id, channel_id, agent_member_id, created_by_member_id, runtime, status,
command, sandbox_id, snapshot_id, exit_code, result, caps(jsonb), started_at, ended_at,
created_at`. Status ∈ `provisioning | running | completed | failed | timeout | idle_reaped |
canceled`. Indexed by workspace, channel, and status (reaper sweep). Migration `0025` + down.

## REST surface (capability- and tenant-gated)
```
POST   /channels/:cid/agent-sessions            launch (write cap) -> 202 { id, status }
GET    /channels/:cid/agent-sessions            list   (read cap)
GET    /channels/:cid/agent-sessions/:id        status (read cap)
POST   /channels/:cid/agent-sessions/:id/cancel cancel (write cap)
```
Launch verifies the target agent is an agent-member of the same workspace, adds it to the
channel and grants it `write` (so its streamed messages are legitimate), then hands off to the
`SessionManager`. The route returns immediately; the session runs server-side.

## Observability
- Per-session child logger bound `{ sessionId, workspaceId, runtime }`; secrets never logged.
- Metrics (dependency-free registry, extends #19): `agent_sessions_total{runtime,status}`
  counter, `agent_sessions_active` gauge, `agent_sandbox_spinup_seconds` histogram. **No tenant
  labels** (cardinality discipline — tenant lives in logs/traces).

## Testing strategy
- **Unit (hermetic, no DB — `pnpm test`):** secret redaction (values scrubbed from text);
  runtime factory selects Local/Sandbox by env; idle reaper cancels a silent session under fake
  timers; wall-clock cap fires; `SandboxRuntime` against a **fake `SandboxProvider`** snapshots
  then stops on completion (reaped), stops on idle/cancel, and **never includes secret values in
  the snapshot payload or logs**.
- **Integration (real Postgres/Redis, `LocalRuntime`, no cloud — `pnpm test:integration`):**
  launch a session via REST, **close the WebSocket client**, then poll the channel and assert the
  agent's streamed output + final result message land and the `agent_sessions` row reaches
  `completed`. A second case asserts an idle session is reaped to `idle_reaped`.
- The demo (`scripts/demos/25-cloud-execution.sh`, recorded as the PR video) spawns a session,
  drops the client, and shows the result arriving in the channel.

## Boundaries
- **Always:** treat agent code as untrusted and isolate per session; cap resources + wall-clock;
  scope secrets per tenant and redact them from logs/output; reap every sandbox; default backend
  stays `local`; write the failing test first; attach the demo video.
- **Ask first:** changing the default runtime to cloud for all users; adding a real runtime
  dependency loaded in CI; anything that incurs real cloud spend in CI.
- **Never:** run agent-authored code on the host; bake secrets into snapshots or logs; leave a
  sandbox un-reaped; let the launch route accept an arbitrary host command from a client; merge
  without approval + video.

## Success criteria
1. `AgentRuntime` + `LocalRuntime` + `SandboxRuntime`; backend chosen by `AGENT_RUNTIME` (default
   `local`).
2. Launch a session, disconnect the client, and the streamed output + result land in the channel
   and persist (integration test).
3. Sessions reaped on completion + idle; caps enforced (unit + integration).
4. Per-tenant secrets injected at provision, absent from snapshots and logs (unit test).
5. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green; integration green.
6. ADR-0025 + spec + demo `docs/demos/25-cloud-execution.mp4`; PR links #25; **not** merged.

## Plan (atomic)
1. `agent_sessions` migration + schema + repository — *slice 1*.
2. `AgentRuntime` interface, `LocalRuntime`, `SandboxRuntime` + `SandboxProvider`, redaction,
   factory, secrets resolver — *slice 2*.
3. `SessionManager` orchestrator + idle/wall-clock reaper + metrics — *slice 3*.
4. REST routes + app wiring — *slice 4*.
5. Tests (unit + integration, mocked Vercel SDK) — *slice 5*.
6. ADR + operations note + demo + PR — *ship*.

> Approach: defaults-and-go per the maintainer's mandate (DEFINE → PLAN → BUILD with TDD → demo →
> PR; reviewed and merged by @gagan114662 on the video). No merge without approval.
