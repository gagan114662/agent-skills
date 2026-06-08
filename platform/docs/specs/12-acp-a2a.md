# Spec: Reload Platform — ACP + A2A Protocol Adapters (Issue #12)

> Implements [#12](https://github.com/gagan114662/agent-skills/issues/12). Phase 2 — Agent
> integration. Depends on #10 (cloud execution / agent sessions, [ADR-0025](../adrs/0025-cloud-execution.md))
> and #11 (framework-agnostic REST + CLI, [ADR-0011](../adrs/0011-rest-cli.md)). Also builds on #3
> (auth/identity), #4 (channels/messages), #6 (threads/mentions), #9 (RBAC), #14 (tasks).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). No code until the design is settled.

## Objective
**What:** Two thin **protocol adapters** so agents that speak the published **ACP** (Agent
Communication Protocol) and **A2A** (Agent2Agent) standards interoperate with Reload **with no
custom glue** — they reach the same workspace, channels, threads, tasks, and identities the
native REST surface (#11) exposes, but through the wire formats those agent frameworks already
emit. Plus a **capability handshake**: each registered agent is published as a standards-compliant
descriptor (an A2A *AgentCard* / an ACP *agent manifest*) so a caller learns what an agent can do
*before* it sends.

**Why:** Reload's reach is "any agent framework can join" (the #11 thesis). #11 delivered that for
agents willing to call Reload's own REST contract. But a growing set of frameworks (Google ADK,
LangGraph, BeeAI, CrewAI bridges) speak **A2A** or **ACP** natively — they discover a peer via an
AgentCard/manifest and then send JSON-RPC (A2A) or REST runs (ACP). Today such an agent needs a
hand-written shim per integration. #12 removes that: Reload *speaks the protocols*, so those agents
talk to it (and hand work to each other through it) directly.

**Who:** External agents authenticating with the existing agent Bearer token (`rld_agt_…`, #3).
Everything is workspace-scoped (#3 IDOR) and capability-respecting (#9): **the adapters grant no
new authority.** They are a second *spelling* of the same identity/RBAC/data the native routes
already enforce — never a weaker side door.

## Design principle: reuse, don't reinvent (the #11 lesson, applied again)
The adapters add **no new table, no new authority, no new data model.** They translate between two
external wire formats and the existing internal model:

| Internal concept | Source | A2A spelling | ACP spelling |
|---|---|---|---|
| identity (agent member) | #3 | `AgentCard` | agent *manifest* |
| message / thread (#4/#6) | #4/#6 | `Message` / `Task.history` | `Message` / a *run*'s I/O |
| task + events + links (#14) | #14 | `Task` + `TaskStatus` | (handoff target) |
| capability ladder (#9) | #9 | card `securitySchemes` + skills | manifest metadata |

Each adapter is a **route module that composes existing repos + auth helpers** (`requireIdentity`,
`requireChannelCapability`, `requireTaskInWorkspace`, `postMessage`, `createTask`, `assignTask`,
`getAgentMember`, `resolveAndPersistMentions`) plus **pure mapping functions** that are unit-tested
in isolation. The only genuinely new artifacts are: the two adapter route files, the pure
mappers/types, a tiny dependency-free JSON-Schema validator, and **vendored published-schema
fixtures** for conformance.

---

## A2A adapter — agent↔agent handoff + capability handshake

A2A is **JSON-RPC 2.0 over HTTP**, preceded by **AgentCard** discovery. We mount it under `/a2a`.

### Capability handshake — the AgentCard
`GET /a2a/agents/:agentId/agent-card.json` returns the A2A **AgentCard** for a registered agent,
*derived* (a pure function, `buildAgentCard`) from the `agents` registry (#3: `name`, `framework`)
+ the platform's transport URL + the RBAC posture (#9):

- `protocolVersion`, `name`, `description`, `version`, `url` (the A2A JSON-RPC endpoint),
  `preferredTransport: "JSONRPC"`.
- `capabilities: { streaming:false, pushNotifications:false, stateTransitionHistory:true }`
  — an honest statement of what this adapter supports today.
- `defaultInputModes` / `defaultOutputModes`: `["text/plain"]`.
- `skills`: at minimum a `handoff` skill ("accept a delegated task with context") and a `messaging`
  skill; `framework` (when set) is surfaced as a skill tag so a caller can route by it.
- `securitySchemes: { bearerAuth: { type:"http", scheme:"bearer" } }` + `security:[{bearerAuth:[]}]`
  — the card *is* the capability handshake: it tells a caller exactly how to authenticate and what
  the agent will accept.

The card is **workspace-scoped**: it is served only to an authenticated caller and only for an agent
in the caller's workspace (a card for another workspace's agent → 404, #3 IDOR). It contains no
tenant secrets — just the public-within-workspace agent profile.

### Handoff — JSON-RPC `POST /a2a/agents/:agentId`
A single JSON-RPC 2.0 endpoint (envelope `{jsonrpc:"2.0", id, method, params}` →
`{jsonrpc:"2.0", id, result}` | `{…, error:{code,message}}`). The authenticated identity is the
**sending** agent; `:agentId` is the **receiving** agent. Methods:

- **`message/send`** — *the handoff.* `params.message` is an A2A `Message` (parts). The adapter:
  1. resolves `:agentId` → the receiving agent's member (`getAgentMember`, must be an active agent
     in the caller's workspace, else JSON-RPC error mapping to 404);
  2. flattens the message parts to text (the preserved context) and **`createTask`** a task
     assigned to the receiving agent, `description` = that context, a `a2a` label;
  3. returns an A2A **`Task`** (`kind:"task"`, `id` = task id, `contextId` = task id,
     `status.state` mapped from the internal status, `history:[the submitted message]`).
  → **"A2A handoff transfers a task with context intact":** the receiving agent calls `tasks/get`
  and gets the task *and the original message content* back. Context lives in the task
  (`description` + reconstructed `history`), durably, in the receiving agent's workspace.
  Optionally, when the sender supplies `params.metadata.channelId` (a channel both can access),
  the adapter also posts the context as a channel message @mentioning the receiver and `task_link`s
  it — so the handoff is visible in the conversation too. (Default path needs no channel.)
- **`tasks/get`** — `params.id` → `requireTaskInWorkspace` → returns the A2A `Task` (status from
  internal status; `history` reconstructed from the stored context; `artifacts:[]`). Cross-workspace
  id → 404-equivalent JSON-RPC error.
- **`tasks/cancel`** — `params.id` → `updateStatus(…, "canceled")` (guarded by `canTransition`;
  illegal transition → JSON-RPC error) → returns the updated A2A `Task` (`state:"canceled"`).
- unknown method → JSON-RPC error `-32601` (Method not found).

**State mapping (internal `TaskStatus` ⇄ A2A `TaskState`):**
`backlog|todo → submitted`, `in_progress → working`, `blocked → input-required`,
`done → completed`, `canceled → canceled`. Reverse only for `cancel` (→ `canceled`).

---

## ACP adapter — messages map to channels/threads

ACP is **plain REST + JSON**, run-centric, preceded by an **agent manifest** listing. Mounted under
`/acp`. An **ACP run is realized as a Reload thread** (#6) in a channel (#4) — the most faithful,
zero-new-table mapping, and the one the acceptance criterion names ("ACP messages map correctly to
channels/threads").

### Discovery — agent manifests
- `GET /acp/agents` → the caller's workspace agent roster as ACP `Agent` manifests (`name`,
  `description`, `metadata` — `framework`, `kind:"agent"`), from `listAgents`. Workspace-scoped.
- `GET /acp/agents/:name` → one manifest by handle (404 if not an agent in this workspace).

### Runs — `POST /acp/runs`
Body `{ agent_name, input: Message[], session_id?, metadata?: { channel_id } }` (ACP `Message` =
`{role, parts:[{content_type, content, …}]}`).
1. Resolve the **target channel**: `session_id`'s thread-root channel if continuing a run, else
   `metadata.channel_id`. The authenticated caller must have **`write`** on it
   (`requireChannelCapability`).
2. Resolve **`agent_name`** → an agent member in the workspace (so the run targets a real agent;
   404 otherwise).
3. Post each `input` message into the channel (parts flattened to text, prefixed `@agent_name` on
   the **root** so the run is an actionable mention #6): a **new** run posts the first message as a
   thread **root** and the rest as **replies**; a `session_id` posts every message as a **reply** to
   that root (thread continuation). This is the literal "messages → channel/thread" mapping.
4. `run_id` = `session_id` (echoed) = the **thread-root message id**. Return an ACP `Run`
   (`run_id`, `agent_name`, `session_id`, `status`, `output`, `created_at`).

### Reading a run — `GET /acp/runs/:run_id`
Loads the thread (`run_id` = root id, must be in the caller's workspace). The run's **`agent_name`**
is the first agent-kind member @mentioned on the root; the run's **`output`** is the thread replies
authored by *that* agent, mapped to ACP `Message`s (`role:"agent"`). `status` is derived:
`completed` if the target agent has replied, else `created`. (We do not synchronously execute the
agent — an ACP client posts a run and polls; live execution is #10/#25's job and out of scope here.)

### Cancel — `POST /acp/runs/:run_id/cancel`
Returns the run with `status:"cancelled"`. Best-effort and non-destructive: it does not delete
messages (a thread is durable conversation); it signals the ACP client the run is done. (A future
revision can pair this with `agent-sessions` cancellation when a run is backed by a live session.)

**Run-status mapping (derived):** no replies → `created`; ≥1 target-agent reply → `completed`;
explicit cancel → `cancelled`. (`in-progress`/`awaiting`/`failed` are reserved for the
session-backed follow-up.)

---

## Conformance — validation vs the published schemas
The acceptance criterion is "conformance tests pass." We assert that **every protocol object the
adapters emit** (`AgentCard`, A2A `Task`/`Message`, ACP `Agent`/`Run`/`Message`) validates against
the **published JSON Schemas** for each protocol.

- **Vendored schema fixtures** (`apps/server/test/fixtures/{a2a,acp}.schema.json`): focused subsets
  of the published A2A and ACP JSON Schemas — the exact `$defs` our adapters produce — transcribed
  verbatim from the upstream specs, each pinned to a spec version and annotated with its source URL
  (`x-source`, `x-spec-version`). We vendor a **subset** (not the full upstream file) for the same
  reason #11 published a focused OpenAPI document rather than annotating all 30 routes: the contract
  we make should be the one we actually emit, and it must validate **offline** (CI has no network).
- **Dependency-free validator** (`src/protocols/jsonschema.ts`): a small JSON-Schema validator
  (supports `$ref` to local `$defs`, `type` incl. unions, `enum`, `const`, `properties`, `required`,
  `items`, `additionalProperties`, `oneOf`/`anyOf`/`allOf`; ignores annotation keywords). We
  hand-roll it rather than add `ajv` for the **same reason #11 hand-wrote its OpenAPI types instead
  of adding `@fastify/swagger`**: no new dependency, no install/network in the build gates, and it
  is itself unit-tested. (ADR records this; `ajv` is the considered-and-rejected alternative.)
- **Conformance tests** (unit): feed representative internal objects through the pure mappers and
  assert the output validates against the vendored schema; plus negative tests (a deliberately
  malformed object fails) so the validator can't pass everything.

---

## In scope
- `src/protocols/a2a/{types,map}.ts`, `src/protocols/acp/{types,map}.ts` — pure types + mappers.
- `src/protocols/jsonschema.ts` — dependency-free JSON-Schema validator.
- `src/routes/a2a.ts` — `GET /a2a/agents/:agentId/agent-card.json`; JSON-RPC `POST /a2a/agents/:agentId`
  (`message/send`, `tasks/get`, `tasks/cancel`).
- `src/routes/acp.ts` — `GET /acp/agents`, `GET /acp/agents/:name`, `POST /acp/runs`,
  `GET /acp/runs/:run_id`, `POST /acp/runs/:run_id/cancel`.
- Small **read-only** repo helpers: resolve an agent member by handle; list the mentions on a message.
- Wiring in `buildApp` (after `agentInterfaceRoutes`, grouped with the agent surface).
- Vendored A2A + ACP schema fixtures + conformance tests; unit tests for the validator + mappers;
  integration tests (real Postgres) for both acceptance flows + cross-workspace rejection.
- Docs: `docs/integrations/acp.md`, `docs/integrations/a2a.md`; ADR-0012; demo
  `scripts/demos/12-acp-a2a.sh` → `docs/demos/12-acp-a2a.mp4`.

## Out of scope (deferred)
- **A2A streaming** (`message/stream`, SSE) and **push notifications** — the card advertises both
  as `false`. Additive later.
- **Synchronous/live run execution** for ACP (`mode:"stream"`/`"sync"` actually running the agent) —
  that is #10/#25's runtime; here a run posts the conversation and an ACP client polls. A
  session-backed run (ACP run ⇄ `agent_sessions`) is a noted follow-up.
- **gRPC / HTTP+JSON** A2A transports (we ship JSON-RPC, the default).
- **A2A `tasks/pushNotificationConfig/*`, `tasks/resubscribe`, authenticated extended cards.**
- **FilePart/DataPart fidelity beyond text** — non-text parts are normalized to a text
  representation in the handoff context (documented); binary artifact storage is a separate change.
- A new table or any new authority. (Strongly preferred: reuse.)

## Endpoints (new), shapes
```
A2A
GET  /a2a/agents/:agentId/agent-card.json   → 200 AgentCard (auth; workspace-scoped; 404 cross-ws)
POST /a2a/agents/:agentId                    → 200 JSON-RPC result (message/send→Task, tasks/get→Task,
                                                  tasks/cancel→Task) | JSON-RPC error; 401 if no token

ACP
GET  /acp/agents                             → 200 [Agent manifest]            (auth; workspace-scoped)
GET  /acp/agents/:name                        → 200 Agent manifest | 404
POST /acp/runs                                → 201 Run   (posts input → channel/thread; needs write)
GET  /acp/runs/:run_id                        → 200 Run   (thread → output; 404 cross-ws)
POST /acp/runs/:run_id/cancel                 → 200 Run   (status:"cancelled")
```
No request/response shape of any existing route changes. No migration.

## Security (carried forward, not loosened)
- **Auth on every call** via `requireIdentity` (#3). `agent-card.json` and `/acp/agents*` require a
  workspace token (discovery is intra-workspace). The JSON-RPC handoff authenticates the *sending*
  agent; the receiver is addressed by id.
- **Workspace-scoped (#3 IDOR):** an agent id / task id / channel id / run id from another workspace
  is a 404 (A2A: the equivalent JSON-RPC error). The adapters only ever read the caller's
  `workspaceId`.
- **Capability-respecting (#9):** ACP run creation requires `write` on the target channel
  (`requireChannelCapability`); A2A handoff assigns a task (workspace-membership gate, like #14). No
  endpoint confers authority the token didn't already have.
- The adapters reuse the **same** helpers the native routes trust, so listing/enforcement can never
  diverge from #11/#4/#9.

## Service/repo layer (routes stay thin)
- **No new repo table.** New functions are **read-only composition**: `getAgentMemberByHandle(wid,
  name)` (resolve `agent_name`), `listMentionsOnMessage(messageId)` (find a run's target agent). The
  write paths reuse `postMessage`, `createTask`, `assignTask`, `updateStatus`, `addTaskLink`,
  `resolveAndPersistMentions` unchanged.
- `src/protocols/*/map.ts`: pure, unit-testable mapping (no DB, no Fastify).
- `src/routes/{a2a,acp}.ts`: auth + capability gating + mapper calls only.

## Testing strategy
- **Unit (hermetic):**
  - `jsonschema.test.ts` — the validator: `type`/union/`enum`/`const`/`required`/`$ref`/`oneOf`/
    `additionalProperties` pass and fail correctly.
  - `a2a-map.test.ts` — `buildAgentCard` produces a card with `protocolVersion`, `bearerAuth`, a
    `handoff` skill; `toA2ATask` maps each `TaskStatus` to the right `TaskState`; **conformance**:
    card + task validate against the vendored A2A schema; a malformed task fails.
  - `acp-map.test.ts` — `toAcpAgent`/`toAcpMessage`/`toAcpRun`; status derivation; **conformance**:
    agent + run + message validate against the vendored ACP schema; a malformed run fails.
- **Integration (real Postgres, `app.inject`):**
  - **ACP** (`acp.test.ts`): owner creates a channel, registers agent `planner`, grants the caller
    `write` and the agent `write`. `POST /acp/runs {agent_name:"planner", input:[m1,m2],
    channel_id}` → 201; `GET /channels/:cid/messages` shows a **root** (`@planner …`) + a **reply**
    (thread); `GET /acp/runs/:run_id` returns `agent_name:"planner"`, `status:"created"`, `output:[]`.
    The agent replies in-thread (its token) → `GET /acp/runs/:run_id` → `status:"completed"`,
    `output` = that reply as an ACP agent message. Continue with `session_id` → another reply in the
    same thread. **Cross-workspace:** a token from workspace B cannot read A's run (404) or post into
    A's channel.
  - **A2A** (`a2a.test.ts`): `GET /a2a/agents/:agentId/agent-card.json` → 200 card with `bearerAuth`
    + a `handoff` skill (the handshake). Agent A `message/send` to agent B with a text message →
    JSON-RPC result is a `Task` (`state:"submitted"`); agent B `tasks/get` → the task **with the
    original message content intact** in `history`, assignee = B. B `tasks/cancel` → `state:"canceled"`.
    **Cross-workspace:** a card / `tasks/get` for another workspace's id → 404 / JSON-RPC error;
    unauthenticated → 401.
- Reuses the `integration` CI job. **No migration** → the down/up-clean step is unaffected. All
  existing suites stay green.

## Boundaries
- **Always:** authenticate every call (#3); scope every query by `identity.workspaceId`; respect #9
  capability before posting/handoff; reuse existing routes/helpers (thin adapters only); keep mappers
  pure + unit-tested; validate emitted objects against the vendored published schemas; write the
  failing test first; attach a demo video.
- **Ask first:** adding a dependency (e.g. `ajv`, an A2A/ACP SDK); adding a table (e.g. a real `runs`
  table or session-backed runs); A2A streaming / push; changing an existing route's shape.
- **Never:** introduce a second, weaker access path; let an adapter leak another workspace's
  agent/task/channel/run; let the protocol surface grant capability the token didn't have; add a
  migration this issue doesn't need; ship a divergent copy of the auth/RBAC logic.

## Success criteria
1. Both acceptance flows green in the `integration` job against real Postgres: **ACP messages map to
   channels/threads**, **A2A handoff transfers a task with context intact**; existing suites
   unchanged + green.
2. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass from `platform/`.
3. **Conformance:** the AgentCard, A2A `Task`/`Message`, and ACP `Agent`/`Run`/`Message` the adapters
   emit validate against the vendored published-schema fixtures; malformed objects fail.
4. A cross-workspace token is rejected (404 / JSON-RPC error) for every adapter resource.
5. ADR-0012 records the reuse-first / no-new-table / run-as-thread / handoff-as-task /
   dependency-free-validator decisions; `docs/integrations/{acp,a2a}.md` document each adapter with
   `curl` examples; demo `docs/demos/12-acp-a2a.mp4` walks both flows.

## Open questions (defaults chosen; the issue says "implement it fully", so BUILD proceeds on these)
1. **Adapters compose the existing model; no new table, no new authority** (A2A handoff ⇒ a #14
   task; ACP run ⇒ a #6 thread). Alternative (a dedicated `runs`/`a2a_tasks` table, or backing runs
   with #25 sessions) — rejected as premature; noted as a follow-up. OK?
2. **Conformance via vendored published-schema *subsets* + a dependency-free validator** (mirrors
   #11's hand-rolled-OpenAPI / no-Swagger decision), pinned to A2A `v0.3.x` and ACP `2025-draft`.
   `ajv` + the full upstream files — rejected (new dep, network). OK?
3. **A2A = JSON-RPC only**, `streaming/pushNotifications:false`; **ACP = REST, poll-based** (no live
   execution here). OK?
4. **AgentCard / manifest are derived** from the `agents` registry + #9 posture (no new "card"
   storage). OK?
5. **No migration.** OK?
