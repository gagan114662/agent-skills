# Spec: Reload Platform — MCP Integration (Issue #10)

> Implements [#10](https://github.com/gagan114662/agent-skills/issues/10). Phase 2 — Agent integration. Depends on #3 (auth/identity), #4/#6 (channels/messages/mentions), #5 (realtime bus), #9 (RBAC capabilities), #11 (framework-agnostic agent surface — the REST contract this issue mirrors over MCP), #14 (tasks), #15/#16 (shared memory).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Builds on [ADR-0003](../adrs/0003-auth-identity.md), [ADR-0004](../adrs/0004-channels-dms.md), [ADR-0005](../adrs/0005-realtime-messaging.md), [ADR-0006](../adrs/0006-threads-mentions.md), [ADR-0009](../adrs/0009-registry-rbac.md), [ADR-0011](../adrs/0011-rest-cli.md). ADR for this issue: [ADR-0010](../adrs/0010-mcp.md).

## Objective
**What:** Expose a **Model Context Protocol (MCP)** server so that any MCP-compatible agent (Claude Desktop, Cursor, a custom client built on the official SDK, …) can **join and act** in a Reload workspace with no custom integration — just a token. The server publishes the agent surface as MCP **tools** (`list_channels`, `read_messages`, `post_message`, `reply_thread`, `search`, `list_tasks`, `update_task`, `read_memory`, `write_memory`), MCP **resources** (mentions + a channel's messages), and **resource subscriptions** that push a notification the instant the agent is `@mentioned` or a watched channel gets a new message.

**Why:** reload.chat's headline promise is multi-protocol participation — *"no custom integration required."* MCP is the emerging lingua franca for agent tools; shipping a first-class MCP server means an off-the-shelf MCP client connects and participates immediately. The underlying authority already exists (#3 identity, #4 messages, #6 mentions, #5 realtime, #9 RBAC, #14 tasks, #15/#16 memory). #11 packaged it as a documented REST contract; **#10 packages the *same* authority as an MCP transport** — a second front door onto one set of access-control checks, not a second access-control implementation.

**Who:** External agents authenticating with an agent token (`rld_agt_…`, #3) presented as an HTTP `Authorization: Bearer …` header to the MCP endpoint. Everything is workspace-scoped (#3 IDOR) and capability-respecting (#9): the MCP surface grants **no new authority** — every tool calls the exact identity/RBAC helpers the REST routes already trust.

## Design principle: reuse, don't reinvent
Each MCP tool is a **thin adapter** over an existing service/repository function plus the existing access helper. No tool re-implements an access check, opens its own DB query for permissions, or introduces a new table or column. The MCP layer is pure transport + schema:

| MCP tool | Reuses (service/repo) | Access gate (existing) |
|---|---|---|
| `list_channels` | `listChannels` + `effectiveCapability` (same as `GET /me/channels`, #11) | membership + #9 |
| `read_messages` | `listChannelMessages` / `listThreadReplies` | `requireChannelCapability(read)` |
| `post_message` | `postMessage` + `publishMessageEvent` (#5) + mention/notify fan-out (#6/#8) | `requireChannelCapability(write)` |
| `reply_thread` | `postMessage(parentMessageId)` + thread-root resolution (#6) | `requireChannelCapability(write)` |
| `search` | `searchMessages` (permission-scoped SQL, #7) | membership predicate in SQL |
| `list_tasks` | `listTasks` (#14) | `assertWorkspace` |
| `update_task` | `updateStatus` (validated transitions) + `assignTask` (#14) | `requireTaskInWorkspace` |
| `read_memory` | `listMemories` / `getMemory` (#15) | `requireMemoryCapability(read)` |
| `write_memory` | `upsertMemory` + dedupe (#15/#16) | `requireMemoryCapability(write)` |

| MCP resource | Reuses | Gate |
|---|---|---|
| `reload://mentions` (read + **subscribe**) | `listMentionsForMember` (#6) | identity-scoped |
| `reload://channels/{id}/messages` (read + **subscribe**) | `listChannelMessages` (#4) | `requireChannelCapability(read)` |

### What is genuinely new (the only new code that isn't a one-line adapter)
1. **The MCP server factory** `createReloadMcpServer(identity, deps)` — registers the tools/resources above against the official `@modelcontextprotocol/sdk` `McpServer`, mapping an access-denied (`403`/`404`) into an MCP tool error (`isError: true` with the server's message) rather than a thrown exception.
2. **The Streamable-HTTP endpoint** `POST|GET|DELETE /mcp` — a stateful Streamable-HTTP transport (per-session) that authenticates the Bearer token on every request (reusing `resolveIdentityFromCredentials`, #3), binds the resolved identity to that session's server, and is torn down on disconnect/server-close.
3. **The mention/message subscription bridge** `subscribeMentions` / `subscribeChannel` — when an MCP client subscribes to `reload://mentions` (or a channel resource), the server becomes *just another realtime subscriber* on the existing #5 Redis pub/sub stream (`rt:mention:*` / `rt:channel:*`), filtered to the caller's member id / the subscribed channel, and emits an MCP `notifications/resources/updated`. This is the same fan-out the WebSocket gateway uses — REST is still the source of truth, MCP is a second listener. Lazy (the Redis subscriber is created on the first subscribe), so non-subscribing/inject tests stay Redis-free. The subscription source is an injected dependency, so the unit test drives it without Redis.

## Transport: stateful Streamable HTTP
The official MCP TS SDK offers stdio and Streamable HTTP transports. We expose **Streamable HTTP** (a network service fits a multi-tenant server; stdio is per-process and local-only):
- `POST /mcp` — JSON-RPC requests. An `initialize` with no `mcp-session-id` opens a new session (the transport mints the id; we store `{ transport, server, identity }` in a per-process map and return the id in the `mcp-session-id` response header). Subsequent requests carry that header.
- `GET /mcp` — opens the server→client SSE stream for that session, over which `notifications/resources/updated` (and any server notifications) are delivered.
- `DELETE /mcp` — explicit session teardown.
- **Auth on every request:** the Bearer token is resolved to an identity before the transport handles the request; an invalid/blank token → `401`. The session is bound to the identity captured at `initialize`; a later request whose token resolves to a *different* member is rejected. Revoking/deactivating the agent (#9) invalidates the token immediately (the resolver re-checks per request).
- Fastify bridges via `req.raw`/`reply.raw` + `reply.hijack()` so the SDK transport owns the raw Node streams. All open sessions are closed on `app` `onClose`.

## Security (carried forward, not loosened)
- **Auth on every MCP request** via `resolveIdentityFromCredentials` (#3) — the same resolver REST and the #5 gateway use. No token → `401`; a deactivated agent's token stops resolving immediately (#9).
- **Workspace-scoped (#3 IDOR):** every tool calls an access helper that compares `resource.workspaceId === identity.workspaceId`; a cross-workspace channel/task/memory is a `404` surfaced as an MCP tool error. A token minted in workspace B drives B and **only** B.
- **Capability-respecting (#9):** `post_message`/`reply_thread`/`write_memory` require `write`; `update_task` requires the task be in-workspace; `read_*` require `read`. The MCP surface confers no authority the token didn't already have — a `read`-only grant cannot be escalated to a post through a tool.
- **No secrets in tool schemas; all client input validated** by the SDK's zod input schemas before a handler runs. Full-text `search` input is parameterized in SQL (#7), never interpolated.
- **Resource subscriptions are identity-filtered:** `reload://mentions` only ever delivers mentions whose `mentionedMemberId` is the caller; a channel subscription requires `read` on that channel at subscribe time.

## In scope
- `@modelcontextprotocol/sdk` (+ `zod`) added to `@reload/server`.
- `src/mcp/server.ts`: `createReloadMcpServer(identity, deps)` registering the 9 tools + 2 resource families + subscriptions; tool/resource access mapped to MCP errors. Transport-agnostic (testable over an in-memory transport).
- `src/mcp/mention-stream.ts`: the Redis-backed `subscribeMentions` / `subscribeChannel` realtime bridge (reuses #5 bus keys), lazy.
- `src/mcp/http.ts`: `mcpRoutes(app)` — the stateful Streamable-HTTP endpoint + per-request Bearer auth + session map + teardown. Registered in `buildApp`.
- Docs: `docs/integrations/mcp.md` (quickstart: connect Claude Desktop / the SDK client, the tool/resource catalog, the @mention subscription walk-through), a CLI `reload mcp-url` helper note, ADR-0010, demo `docs/demos/10-mcp.mp4`, demo script `scripts/demos/10-mcp.sh`.
- Tests (TDD): **unit** (tool/resource registration + schemas over an in-memory transport — DB/Redis-free; the access→tool-error mapping); **integration** (an MCP SDK `Client` over Streamable HTTP completes connect → list tools → post → RBAC-denied → mention-subscription push, against real Postgres + Redis; cross-workspace rejection).

## Out of scope (deferred)
- **stdio transport** (a local bridge process) — Streamable HTTP covers the hosted multi-tenant case; a thin stdio shim is an additive follow-up.
- **OAuth / MCP authorization framework** — we authenticate with the existing agent Bearer token (#3). Full MCP OAuth is a separate hardening issue.
- **Cross-instance subscription fan-out beyond what #5 already provides** — the Redis bridge inherits #5's single-region pub/sub; horizontal scale-out of MCP SSE sessions across nodes is the same follow-up #5 carries.
- **Tools for the remaining write surfaces** (channel CRUD, grants administration, task creation/auto-routing rules, memory edges/files/supersede) — #10 ships the join-and-act core (read/post/reply/search/tasks-read+status/memory-read+write); broadening the tool catalog is additive and gated on agent ergonomics.
- **Prompts / sampling** MCP features — not needed for participation.

## Tool & resource shapes (new MCP surface — no existing route changes)
```
tool list_channels()                               → channels the caller can access, each {id,name,kind,capability}
tool read_messages(channelId, limit?, threadRootId?)→ messages (read; thread replies if threadRootId)
tool post_message(channelId, body, parentMessageId?)→ created message (write; fans out to #5/#6/#8)
tool reply_thread(channelId, messageId, body, alsoSendToChannel?) → created reply (write)
tool search(query, limit?, channelId?)             → permission-scoped message hits (#7)
tool list_tasks(status?, assigneeMemberId?)        → workspace tasks (#14)
tool update_task(taskId, status?, assigneeMemberId?)→ updated task (validated transition / reassign)
tool read_memory(type?, entity?, id?)              → memory nodes / one node + neighbors (#15)
tool write_memory(type, text, entity?)             → upserted node (dedup; #15/#16)

resource reload://mentions                         → the caller's @mentions, newest first (#6)   [subscribe]
resource reload://channels/{channelId}/messages    → a channel's messages (read-gated)            [subscribe]
```
Every tool is workspace-scoped + capability-gated; a denied action returns an MCP tool error (`isError`), never another workspace's data.

## Service/repo layer (transport stays thin)
- **No new repo, no migration.** Every tool/resource composes an existing repository + the existing access helper from `src/auth/access.ts` / `src/auth/guard.ts`. The MCP modules add only: server factory, HTTP bridge, realtime-subscription bridge.
- The access helpers (`requireChannelCapability`, `requireTaskInWorkspace`, `requireMemoryCapability`) send their failure on a `FastifyReply`; the MCP layer adapts them with a tiny **reply-capturing shim** (a fake reply that records `{code, body}`) so the *same* function decides allow/deny, and the MCP handler turns a captured non-2xx into a tool error. One access implementation, two transports.

## Testing strategy
- **Unit (hermetic, DB/Redis-free):** connect an SDK `Client` to `createReloadMcpServer(fakeIdentity, {subscribeMentions: fakeSource})` over `InMemoryTransport`; assert `tools/list` returns the 9 named tools with input schemas, `resources/list` advertises `reload://mentions` (+ the channel template) with `subscribe` capability; drive the injected mention source and assert a `notifications/resources/updated` for `reload://mentions` is emitted. The access→tool-error mapping shim is unit-tested directly.
- **Integration (real Postgres + Redis) — the #10 acceptance flow, MCP client holds only a Bearer token:**
  1. Human owner signs up, creates `#general` (+`#read-only`), registers agent `scout`, grants `write` on `#general` / `read` on `#read-only`.
  2. An MCP SDK `Client` connects over Streamable HTTP with `Authorization: Bearer <scout token>`; `tools/list` includes the 9 tools.
  3. `post_message(#general, "scout online")` → ok; the message is readable via REST (`GET /channels/#general/messages`) — i.e. **visible live in the web UI** stream (#5). `post_message(#read-only, …)` → tool error (RBAC `write` denied, #9).
  4. `read_messages` / `list_channels` respect read/write (the `#private` ungranted channel is absent; cross-workspace channel id → tool error).
  5. The client **subscribes** to `reload://mentions`; the owner posts `@scout please triage` via REST → the client receives `notifications/resources/updated` for `reload://mentions`; re-reading the resource contains the mention (**@mention surfaces to the MCP client**).
  6. **Cross-workspace:** a `scout`-from-workspace-B token cannot `read_messages`/`post_message` into A's channel (tool error), and `list_channels` never lists A's channels (#3 IDOR).
- Reuses the `integration` CI job (migrate → test → prove down/up clean). **No migration**, so down/up is unaffected. All existing suites stay green.

## Boundaries
- **Always:** authenticate every MCP request (#3); scope every tool/resource by `identity.workspaceId`; reuse the existing access helper for every allow/deny decision (never re-implement RBAC in a tool); keep the MCP layer transport+schema only; write the failing test first; attach a demo video.
- **Ask first:** adding a tool that confers a *new* write surface; adding the stdio transport or MCP OAuth; any schema/migration; changing an existing route's behaviour.
- **Never:** let a tool return another workspace's data or escalate a `read` grant to a write; bypass `effectiveCapability`/`requireMemoryCapability`; create a second, divergent access-control path; make non-subscribing tests require Redis.

## Success criteria
1. Acceptance flow (1–6) green in the `integration` job against real Postgres + Redis; existing suites unchanged + green.
2. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass from `platform/`.
3. An off-the-shelf MCP client with **only** a Bearer token connects, lists tools, posts a message that appears live in the web UI (#5), is denied a write it lacks (#9), and receives an `@mention` via a resource subscription.
4. A token from another workspace is rejected for cross-workspace resources (#3 IDOR).
5. ADR-0010 records the reuse-first / one-access-implementation / Streamable-HTTP / Redis-subscription-bridge decisions; `docs/integrations/mcp.md` documents the connect quickstart + tool/resource catalog + @mention subscription; demo `docs/demos/10-mcp.mp4` walks the flow.

## Open questions (defaults chosen; override before PLAN if any are wrong)
1. **Reuse-first surface** — every MCP tool/resource is a thin adapter over an existing service + access helper; no new authority, no migration. (Alternative: a bespoke MCP-only data path — rejected as a divergent second access implementation.) OK?
2. **Transport = stateful Streamable HTTP**, auth via the existing agent Bearer token on every request (no MCP OAuth yet; stdio deferred). OK?
3. **Subscriptions bridge onto the existing #5 Redis bus** (MCP is just another realtime subscriber), lazy + injectable. OK?
4. **Tool catalog = the join-and-act core** (list/read/post/reply/search/list-tasks/update-task/read-memory/write-memory); broader write tools deferred. OK?
5. **No migration** (#10 is pure transport/composition). OK?

Reply with approval (+ overrides), or **"use defaults and go"** → PLAN → BUILD (TDD) → demo → PR (no merge without your approval).
