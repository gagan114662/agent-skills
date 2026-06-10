# Spec: Reload Platform — Run tab, in-app browser preview + annotations (Issue #56)

> Implements [#56](https://github.com/gagan114662/agent-skills/issues/56). Feature phase 4 — Real
> execution & Conductor parity.
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Built the agent_skills way — every stage
> governed by a skill in `skills/`. Builds on [#25](25-cloud-execution.md) (`AgentRuntime` /
> `LocalRuntime` spawn seam, `SessionManager`, per-session `AgentJob.cwd`), [#28](28-git-pr-review.md)
> (worktree-per-session cwd + the review→agent **round trip**), and [#35](35-config-layering.md)
> (layered config — where the run command is declared).

## Objective
**What:** Give Reload Conductor's **Run tab**: from a session, **run the app** the agent is building,
**detect the localhost port** it binds to, show a **live in-app preview** of the running app, let the
user **click the preview to drop annotations** on it, and **feed those annotations back to the agent**
as the task for a follow-up turn.

**Why:** The platform can launch agents and review their diffs (#27/#28), but a developer still cannot
*see the thing run*. Conductor's loop is run → look → point at what's wrong → the agent fixes it. We
have none of that surface. Closing it makes the platform a place you can actually drive a build from,
not just read patches. It is the visual counterpart to the #28 review round trip: #28 annotates the
**diff**, #56 annotates the **running UI**.

**Who:** A developer attached to a session (channel write capability) who wants to run that session's
app, preview it, and steer the agent by pointing at the UI. The agent (a member of the same channel)
receives the annotations as a new task and acts on them through the proven launch path.

### Acceptance criteria (from #56)
1. **Running a session app shows a live preview** — starting a session's run command spawns its dev
   server, the bound localhost URL is detected, and the web Run tab renders it in an in-app iframe
   preview with live status + logs.
2. **An annotation on the preview reaches the agent as context** — clicking the preview drops a
   coordinate-anchored note; delivering the collected annotations launches a **follow-up agent
   session** in the same channel whose task is the formatted annotation list.
3. `pnpm -C platform typecheck && lint && test && build` green; server integration green.
4. ADR-0033 + this spec + demo script `scripts/demos/33-run-preview-spotlight.sh` (the runnable proof; recorded video pending); PR links #56; **not** merged.
5. *(Stretch / sub-issue)* Spotlight branch hot-swap on one running instance — **out of scope here**
   (see below), filed as a follow-up.

### In scope
- **Run command in config (#35).** Add a `run` section to the layered config schema:
  `run = { command: string, port?: number, readyPattern?: string }`. The command is **trusted config**
  (repo/managed scope), never request-supplied — the same trust boundary as the #27 harness command.
  A session whose resolved config has no `run.command` returns a clear `409 no run command configured`.
- **`RunProcessManager`** (`apps/server/src/run/manager.ts`) — a new, **separate** orchestrator (NOT
  `SessionManager`). It runs **one long-lived** run process per session, reusing `LocalRuntime`'s spawn
  pattern directly (detached process group, `stdio` pipe, `killTree` on stop). It resolves the
  session's working dir via the same `WorkspaceProvisioner` the SessionManager uses (#35/#28), so the
  app runs in the agent's actual worktree. Keyed by `sessionId`; starting twice is idempotent (returns
  the existing run). Lifecycle is **in-memory and ephemeral** — a run process is a child of the server
  and dies with it, so there is no DB row to persist.
- **Port/URL detection** (`apps/server/src/run/detect.ts`) — a **pure** function that scans a process
  output line for a bound localhost URL using a bounded (ReDoS-safe) pattern covering the common dev
  servers (`http://localhost:PORT`, `Local: http://localhost:PORT`, `listening on port PORT`,
  `127.0.0.1:PORT`). An explicit `run.port` in config short-circuits detection. On first match the run
  transitions to `running` with a `url`.
- **Realtime run events.** Two new `ServerEvent` variants on the existing channel bus (no gateway
  change, exactly like the #28 PR events): `run_status` (lifecycle: `starting → running(url) →
  exited(code) | stopped | failed(error)`) and `run_log` (a bounded output chunk). Published via a new
  `publishRunEvent(channelId, event)` in `realtime/bus.ts`.
- **REST routes** (`apps/server/src/routes/run.ts`), all guarded by `requireIdentity` +
  `requireChannelCapability("write")` + channel-scoped `getAgentSession` (IDOR-safe), mirroring
  `routes/agent-sessions.ts`:
  - `POST   /channels/:cid/agent-sessions/:id/run` — start the run process → `202 { status }`.
  - `GET    /channels/:cid/agent-sessions/:id/run` — current run state `{ status, url?, exitCode?,
    logs: string[] }` (bounded tail).
  - `POST   /channels/:cid/agent-sessions/:id/run/stop` — stop (kill the process group) → `200`.
  - `POST   /channels/:cid/agent-sessions/:id/annotations` — body `{ annotations: Annotation[] }` →
    format into a task and `sessionManager.launch({ task, agentMemberId: session.agentMemberId, … })`
    as a follow-up session → `202 { sessionId, count }`. This is the #28 review→agent round trip,
    reused verbatim in shape.
- **Web Run tab** (`apps/web`): a new `"run"` view in `Workspace.tsx`, a `RunState` store slice
  (mirroring `ReviewState`), an `api.run` client namespace, the two new events wired into the store's
  `onEvent`, and a `RunPanel` that: picks a session, Start/Stop the run, shows live status + logs,
  renders the detected URL in an **iframe preview**, and overlays a **coordinate-based annotation
  layer** (the localhost app is cross-origin, so annotations are positioned on our own overlay, not
  derived from the iframe DOM). Collected annotations are delivered to the agent with one action —
  the same "collect → Deliver to agent" UX as #28 review comments.

### Out of scope (deferred / documented-not-automated)
- **Spotlight (single-instance branch hot-swap).** The issue itself flags Spotlight's isolation engine
  as a file-follow-up; this PR ships run + preview + annotations and leaves Spotlight to a sub-issue.
- **Same-origin reverse proxy / public tunnel for the preview.** v1 iframes the detected
  `http://localhost:PORT` **directly** (the LocalRuntime default — server and browser share a host).
  This means (a) a dev server that sets a framing-blocking `X-Frame-Options`/`CSP` won't render (most
  local dev servers — Vite, Next dev, CRA — do not), and (b) a **remote** (sandbox) runtime's port is
  not reachable from the browser. A scoped reverse-proxy / tunnel that makes the preview same-origin
  and cloud-reachable is the documented follow-up; the `url` seam already carries whatever we point at.
- **Persisting annotations or run state.** Annotations are collected client-side and delivered in one
  batch (the value is the round trip, not a record); run state is ephemeral child-process state. No
  migration is introduced.
- **Multiple concurrent run processes per session**, build/preview of arbitrary commands from the
  request body (security — command is config-only), and HMR/websocket proxying.

## The run model
```
RunStatus = "idle" | "starting" | "running" | "stopped" | "exited" | "failed"

RunProcessManager (in-memory, keyed by sessionId)
  start({ sessionId, workspaceId, channelId }) -> RunState
    cfg = loadConfig(workspaceId)
    if !cfg.run?.command            -> throw NoRunCommand (route → 409)
    if running[sessionId]           -> return it (idempotent)
    cwd = provisioner.prepare({ sessionId, workspaceId }).cwd   // agent's worktree (#28/#35)
    proc = spawn(sh, ["-c", cfg.run.command], { cwd, detached, stdio: pipe })   // #25 pattern
    status = "starting";  publishRunEvent(channelId, run_status)
    on stdout/stderr line:
      logs.push(line) (bounded tail);  publishRunEvent(channelId, run_log)
      if status === "starting":
        url = cfg.run.port ? `http://localhost:${cfg.run.port}` : detectUrl(line, cfg.run.readyPattern)
        if url -> status = "running";  publishRunEvent(channelId, run_status{ url })
    on exit(code): status = "exited";  publishRunEvent(channelId, run_status{ exitCode })
  stop(sessionId): killTree(proc);  status = "stopped";  publishRunEvent(...)
  get(sessionId) -> RunState | { status: "idle" }

detectUrl(line, pattern?) -> string | null     // pure, ReDoS-safe, unit-tested
```
**Why a separate manager, not `SessionManager`.** `SessionManager`'s contract is *run a harness to
completion and finalize the session row* — single-shot, teardown-on-exit. A dev server is long-lived
and must never finalize the session. Overloading that path would put a long-running, user-triggered
process inside the most safety-critical, most-tested orchestrator. `RunProcessManager` keeps the blast
radius off it while reusing the exact spawn primitive — the same discipline #28 used with `commitTurn`.

## Annotation round trip (mirrors #28)
```
Annotation = { x: number; y: number; width?: number; height?: number; note: string; pageUrl: string }

POST …/annotations { annotations }
  session = getAgentSession(id, cid)            // channel-scoped → IDOR-safe
  task    = formatAnnotationsTask(annotations)  // "The user annotated the running preview at <url>: …"
  followUp = sessionManager.launch({ workspaceId, channelId: cid, agentMemberId: session.agentMemberId,
                                     createdByMemberId: identity.memberId, task })
  -> 202 { sessionId: followUp.id, count: annotations.length }
```
`x/y` are normalized (0–1) fractions of the preview viewport so the agent gets a stable "top-left / center"
description regardless of pixel size. `formatAnnotationsTask` renders each as
`- (34%, 12%) [120×40] — "the Save button is misaligned"` so the agent has location + intent.

## Security
- **Run command is config-only, never request-supplied.** The command comes from the resolved layered
  config (#35), which is repo/managed scope — the same trust boundary as the #27 harness command
  (`AGENT_TASK` via env, command from `harnessSpec`). The request body for `…/run` carries **no**
  command, so a channel member cannot turn the run endpoint into arbitrary RCE beyond what the
  deployment already chose to make runnable. Starting a run still requires **channel write capability**
  (same gate as launching a session).
- **IDOR-safe.** Every route resolves the session via channel-scoped `getAgentSession(id, cid)`; an
  attacker cannot run/stop/annotate a session in a channel they lack capability on.
- **ReDoS-safe detection.** `detectUrl` uses bounded, anchored character classes (`\d{1,5}`, no nested
  quantifiers); a hostile log line cannot cause catastrophic backtracking. Output is line-buffered and
  the retained log tail is bounded (no unbounded memory growth from a chatty dev server).
- **Cross-origin preview is read-only to us.** The iframe points at the app's own origin; our overlay
  never reads the iframe's DOM (it can't, cross-origin), so the preview cannot exfiltrate page content
  into an annotation — annotations are coordinates + the user's typed note only.
- **Annotation feedback reuses the proven launch path** — RBAC, IDOR, worktree, and channel streaming
  are all the existing `SessionManager.launch` guarantees; no new agent-IPC channel is introduced.

## Testing strategy
- **Unit (hermetic, no DB — `pnpm test`):**
  - **`detectUrl`:** matches `http://localhost:5173`, `Local: http://localhost:3000`,
    `listening on port 8080`, `127.0.0.1:4000`; returns `null` for noise; honors a custom
    `readyPattern`; an explicit `run.port` short-circuits (no scan); a pathological long line returns
    promptly (ReDoS guard).
  - **Config merge:** a `run` section resolves through `env < user < repo < managed`; absent → `run`
    undefined (today's behavior, existing config tests stay green).
  - **`formatAnnotationsTask`:** renders normalized coords, size, and note into the task string.
- **Integration (real Postgres/Redis, LocalRuntime — `pnpm test:integration`):** copy the
  `agent-sessions.test.ts` harness. Configure a `run.command` that launches a tiny `node -e` HTTP
  server which binds a port and logs `listening on http://localhost:PORT`. `POST …/run`; poll
  `GET …/run` until `status: "running"` with a `url`; assert a `run_status` event was published on the
  channel. `POST …/annotations` and assert a **follow-up session row** is created in the channel with
  the formatted task. `POST …/run/stop` and assert the process is gone and status is `stopped`. A
  `409` is returned when no run command is configured.
- **Web (vitest + jsdom + testing-library — local gate; not in CI's `pnpm test`, per #18/#28/#54):**
  `RunPanel` renders the iframe with the detected `url` when running; a click on the overlay adds an
  annotation to the list; "Deliver to agent" calls `api.run.sendAnnotations`; a fired `run_status`
  event updates the panel; the Run nav button switches the `Workspace` view.

## Boundaries
- **Always:** keep the run process off `SessionManager`; take the run command from config only; gate
  every route on channel write capability + channel-scoped session lookup; bound the log tail and the
  detection regex; default no `run.command` → `409` (today's behavior unchanged for sessions without
  one); reuse the #28 launch round trip for annotations; write the failing test first; attach the demo
  video.
- **Ask first:** adding a request-body run command; adding a server-side reverse proxy/tunnel; running
  more than one process per session; persisting annotations/run state in the DB; turning the Run tab on
  for the sandbox runtime.
- **Never:** route the dev server through `SessionManager` (it would finalize the session); accept a
  command from the request body; let a session be run/stopped/annotated across a channel boundary;
  block server boot or leak file contents on a bad config; merge without approval + video.

## Success criteria
1. Starting a session's configured run command spawns it in the session's worktree, the localhost URL
   is detected, and the Run tab previews it live with status + logs (integration + web).
2. Delivering preview annotations launches a follow-up agent session whose task is the formatted
   annotation list, in the same channel (integration).
3. No run command configured → `409`; cross-channel access denied; detection is ReDoS-safe (unit +
   integration).
4. `pnpm typecheck && lint && test && build` green; integration green.
5. ADR-0033 + this spec + demo script `scripts/demos/33-run-preview-spotlight.sh` (the runnable proof; recorded video pending); PR links #56; **not** merged.

## Plan (atomic)
1. **Config:** `run` section in `config/schema.ts` (+ defaults) and `config/layers.ts` merge — *slice 1*.
2. **Detection:** `run/detect.ts` pure `detectUrl` + `formatAnnotationsTask` — *slice 1* (test first).
3. **Manager:** `run/manager.ts` `RunProcessManager` reusing the `LocalRuntime` spawn + `killTree`
   pattern, cwd via the `WorkspaceProvisioner` — *slice 2*.
4. **Realtime:** `run_status` + `run_log` in `realtime/protocol.ts`; `publishRunEvent` in
   `realtime/bus.ts` — *slice 2*.
5. **Routes:** `routes/run.ts` (start/get/stop/annotations) + register in `app.ts` — *slice 2*
   (integration test first).
6. **Web:** `RunState` slice + `api.run` + event wiring + `RunPanel` + Workspace tab + styles — *slice 3*
   (component tests first).
7. ADR-0033 + demo + PR — *ship*.

> Approach: defaults-and-go per the maintainer's mandate (DEFINE → PLAN → BUILD with TDD → demo → PR;
> reviewed and merged by @gagan114662 on the video). No merge without approval.
