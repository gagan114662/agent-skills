# Spec: Reload Platform — Realtime Messaging over WebSocket + Presence (Issue #5)

> Implements [#5](https://github.com/gagan114662/agent-skills/issues/5). Phase 1 — Core chat. Depends on #1, #2, #3, #4.
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Pre-approved by Gagan for end-to-end execution through PR (no merge without review).

## Objective
**What:** A WebSocket gateway that delivers channel messages and workspace **presence** in real time, layered on top of the #4 REST endpoints. Clients connect to `/ws`, authenticate with the **same** `resolveIdentity` model (#3), **subscribe** to channels they are members of (#4 membership), and receive `message` events the instant a message is posted via REST. Presence (online/away/offline) is tracked per workspace and pushed to that workspace's connected clients. Fan-out uses **Redis pub/sub** so delivery works across multiple server instances.

**Why:** #4 made humans and agents able to talk over REST; #5 makes the conversation *live*. It's the delivery layer of the messaging lane — #6 (threads/mentions) and #8 (notifications) build on the same event stream.

**Who:** Humans (session cookie) and agents (Bearer token) — both are `members`, both connect to the same gateway identically.

### Acceptance criteria (from #5)
- A channel **member receives a new message broadcast over WebSocket** in real time (REST stays the source of truth; WS is delivery on top).
- A **non-member cannot subscribe** to a channel (forbidden — the WS equivalent of #4's 403).
- **Presence updates** (online/away/offline) propagate to the workspace.
- Fan-out works across **multiple server instances** via Redis pub/sub.

### Out of scope (deferred)
- **Threads & @mentions** (#6) — `message` events carry flat messages (the `parentMessageId` rides along, but threading UX is #6).
- **Notifications / unread counts** (#8).
- **Fine-grained RBAC** (#9) — subscription uses the same membership check as #4.
- **Message edit/delete events**, typing indicators, read receipts — not required by #5; the event envelope is designed to extend to them later without breaking changes.
- **No DB migration.** Presence is ephemeral runtime state and lives in Redis; messages already persist via #4. No schema change is needed or made.

## Transport & protocol
**Endpoint:** `GET /ws` (HTTP Upgrade → WebSocket), attached to the existing Fastify HTTP server via the `ws` library (already a dependency). Restricted to the `/ws` path so REST routes are untouched.

**Handshake auth (reuses #3):** credentials are extracted from the upgrade request and run through the *same* identity resolver as REST:
- Agents: `Authorization: Bearer reload_…` header, or `?access_token=` query param (browsers can't set WS headers).
- Humans: the `rid` session cookie (sent automatically by browsers), or `?rid=` query param.
- No valid identity → the upgrade is rejected with **HTTP 401** before the socket opens.

**Client → server messages** (JSON):
```jsonc
{ "type": "subscribe",   "channelId": "…" }   // subscribe to a channel's messages (membership-checked)
{ "type": "unsubscribe", "channelId": "…" }   // stop receiving that channel's messages
{ "type": "presence",    "status": "online" | "away" }  // update own presence
{ "type": "ping" }                            // liveness; server replies { "type": "pong" }
```

**Server → client events** (JSON, discriminated by `type`):
```jsonc
{ "type": "ready",      "memberId": "…", "workspaceId": "…" }      // sent on connect
{ "type": "subscribed", "channelId": "…" }                        // ack
{ "type": "message",    "message": { id, channelId, authorMemberId, parentMessageId, body } }
{ "type": "presence",   "memberId": "…", "status": "online" | "away" | "offline" }
{ "type": "error",      "code": "forbidden" | "bad_request" | "not_found", "detail": "…" }
{ "type": "pong" }
```

A non-member `subscribe` returns `{ "type": "error", "code": "forbidden" }` and the socket is **not** added to that channel's subscriber set (the WS analogue of the #4 403).

## Redis fan-out (cross-instance)
REST stays the **source of truth**; realtime is publish-on-write:
- When `POST /channels/:cid/messages` persists a message (#4), the route also **publishes** it: `PUBLISH rt:channel:{cid} <message-event>`.
- Each server process runs **one subscriber connection** (a `duplicate()` of the shared ioredis client) that **`PSUBSCRIBE rt:channel:*`** and **`rt:presence:*`**. On a `pmessage`, the gateway looks up *local* sockets subscribed to that channel/workspace and writes the event to them. This makes delivery instance-agnostic: a message posted on instance A reaches subscribers connected to instance B.
- Presence changes publish to `rt:presence:{workspaceId}`; every socket in that workspace receives them.

The Redis subscriber is created **lazily on the first WS connection** — so `app.inject` REST tests and the no-Redis `quality` CI job never open a Redis socket (matching the existing lazy-Redis discipline in `redis/index.ts`).

## Presence model
- Per-workspace state in a Redis hash `presence:{workspaceId}` → `{ memberId: "online" | "away" }`, used to answer "who's here" snapshots.
- On connect: mark the member `online`, publish `{type:"presence", memberId, status:"online"}` to the workspace.
- On `{type:"presence", status}`: update the hash + publish.
- On disconnect of a member's **last** local socket: mark `offline` and publish. (Multi-instance same-member presence is best-effort — see ADR; a member connected on two instances may flap to `offline` when one drops. Acceptable for #5; a refcount-in-Redis hardening is noted as future work.)

## Code layout
- `src/realtime/protocol.ts` — shared event/command types + a tiny safe JSON parser.
- `src/realtime/bus.ts` — Redis publish helpers (`publishMessageEvent`, `publishPresence`) + channel-name builders. Pure, importable by REST routes without pulling in the socket server.
- `src/realtime/gateway.ts` — `attachRealtime(app)`: creates the `WebSocketServer` on `app.server` (path `/ws`), authenticates handshakes, manages per-socket subscriptions, owns the lazy Redis subscriber, and registers an `onClose` hook to tear everything down.
- `src/auth/middleware.ts` — extract the core resolver into `resolveIdentityFromCredentials({ authorization, sessionToken })`; `resolveIdentity(req)` delegates to it, and the gateway calls it with credentials parsed from the raw upgrade request. No behavior change for REST.
- `src/routes/channels.ts` — after a message is persisted, `publishMessageEvent(channelId, message)`. One line; REST contract unchanged.
- `src/app.ts` — call `attachRealtime(app)` after routes are registered.

## Testing strategy
- **Integration (real Postgres + real Redis, `test/integration`):** the gateway needs a real socket, so these tests `app.listen({ port: 0 })` and connect a real `ws` client.
  1. **Member receives broadcast:** human creates a channel, connects WS (cookie), `subscribe`s, then a message is `POST`ed via REST → the WS client receives a `message` event with the same body. (Also asserts cross-publish via Redis works end to end.)
  2. **Non-member blocked:** an agent who is a workspace member but **not** a channel member connects (Bearer), `subscribe`s → receives `{type:"error", code:"forbidden"}` and never receives the broadcast.
  3. **Presence:** member A connects; member B connects → A receives a `presence` event that B is `online`; B sends `away` → A receives `away`.
  - Plus: unauthenticated upgrade → connection rejected (401).
- Runs in the existing `integration` CI job (already has Postgres **and** Redis service containers).
- **Unit (`test/unit`, no Redis):** pure helpers — the credential extractor (header vs query vs cookie precedence) and the protocol parser (rejects malformed frames). These run in the no-Redis `quality` job, so they must not import the socket server or open Redis.

## Quality gates (must pass before PR)
From `platform/`: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, plus `pnpm --filter @reload/server test:integration` against real Postgres + Redis.

## Boundaries
- **Always:** authenticate every WS handshake with the #3 identity model; enforce #4 channel membership before adding a socket to a channel's subscriber set; scope subscriptions and presence by `identity.workspaceId`; keep REST the source of truth (publish-on-write); write the failing integration test first; attach a demo.
- **Ask first:** adding a DB table for presence/delivery; changing the REST message contract; introducing a new top-level dependency beyond the already-present `ws`/`ioredis`.
- **Never:** let a non-member subscribe or receive a channel's messages; leak events across workspaces; require Redis for the REST/`inject` path or the no-Redis `quality` job; merge without approval + video.

## Success criteria
1. Subscribed channel member receives a `POST`ed message as a WS `message` event in real time (integration-tested).
2. Non-member `subscribe` → `{type:"error", code:"forbidden"}`, no broadcast received (integration-tested).
3. Presence online/away propagates to the workspace (integration-tested).
4. Fan-out goes through Redis pub/sub (publish-on-write + `PSUBSCRIBE`), so it works across instances; REST contract unchanged.
5. All quality gates green (typecheck, lint, unit test, build) + integration green in CI; **video** `platform/docs/demos/05-realtime-messaging.mp4` (connect → subscribe → live message → presence → non-member blocked) + **ADR-0005** for the realtime/presence decisions.

## Decisions (resolved — pre-approved for end-to-end execution)
1. **Single `/ws` endpoint, channel multiplexing.** One socket per client; subscribe/unsubscribe to many channels over it — rather than a socket per channel. Simpler client, fewer connections. → ADR-0005.
2. **Publish-on-write fan-out via `PSUBSCRIBE rt:channel:*`.** REST write publishes; one subscriber per process fans out to local sockets. Cross-instance by construction; no per-channel subscribe bookkeeping. → ADR-0005.
3. **Presence in Redis, not Postgres.** Presence is ephemeral; keeping it out of Postgres honors the "no migration" constraint and avoids write amplification. Best-effort multi-instance semantics, noted as future hardening. → ADR-0005.
4. **Membership reuse, no new access model.** WS subscribe calls the same `isChannelMember` + workspace guard as #4; #9 will layer RBAC on the same seam.
