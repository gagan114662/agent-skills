# ADR-0005: Realtime Messaging over WebSocket + Presence

- **Status:** Accepted (Gagan pre-approved end-to-end execution — issue #5)
- **Date:** 2026-06-06
- **Context issue:** [#5](https://github.com/gagan114662/agent-skills/issues/5)
- **Builds on:** [ADR-0003](0003-auth-identity.md), [ADR-0004](0004-channels-dms.md)

## Context
#4 delivered channels/DMs/messages over REST. #5 makes delivery *live*: members should
receive new messages and presence the moment they happen, and it must work when the
platform runs as more than one server instance. REST must remain the source of truth.

## Decisions
1. **One `/ws` socket, channel multiplexing.** Clients open a single authenticated
   WebSocket and `subscribe`/`unsubscribe` to many channels over it, rather than a socket
   per channel. Fewer connections, simpler client, and presence rides the same socket.
   The transport is the `ws` library attached to the existing Fastify HTTP server via a
   manual `upgrade` handler (already a dependency; no `@fastify/websocket` added).
2. **Handshake reuses the #3 identity model.** Auth is factored into
   `resolveIdentityFromCredentials({ authorization, sessionToken })`; `resolveIdentity(req)`
   (REST) and the gateway both call it. The gateway sources credentials from the upgrade
   request — `Authorization: Bearer` / `rid` cookie, plus `?access_token=` / `?rid=` query
   fallbacks because browsers can't set headers on a `WebSocket`. A bad/absent identity is
   rejected with a real **HTTP 401** before the socket opens.
3. **Subscribe is gated by #4 membership.** A `subscribe` runs the same `getChannel` +
   workspace guard + `isChannelMember` check as the REST routes; a non-member gets
   `{type:"error", code:"forbidden"}` and is never added to the channel's subscriber set —
   the realtime analogue of #4's 403. No new access model; #9 RBAC layers on the same seam.
4. **Publish-on-write fan-out via Redis pub/sub.** The REST `POST messages` route stays the
   source of truth and additionally `PUBLISH`es the persisted message to `rt:channel:{cid}`.
   Each server process runs **one** subscriber connection (`duplicate()` of the shared
   ioredis client) that `PSUBSCRIBE rt:channel:*` and `rt:presence:*`, then fans out to its
   *local* sockets. This is cross-instance by construction: a message posted on instance A
   reaches subscribers on instance B. The publish is **best-effort** (fire-and-forget,
   errors logged) so a Redis hiccup degrades realtime but never fails a REST write.
5. **Lazy Redis subscriber.** The subscriber/`PSUBSCRIBE` is created on the *first* WS
   connection, not at boot. So `app.inject` REST tests and the no-Redis `quality` CI job
   never open a Redis socket — matching the lazy-Redis discipline already in `redis/index.ts`.
6. **Presence in Redis, not Postgres.** Presence is ephemeral runtime state: a per-workspace
   Redis hash `presence:{workspaceId}` (`memberId` → `online|away`) for snapshots, with
   changes published to `rt:presence:{workspaceId}`. This honors the #5 "no migration"
   constraint and avoids write amplification on Postgres. A member goes `online` on their
   first local socket and `offline` on their last.

## Consequences
- Realtime delivery works across multiple instances with no sticky sessions; the only shared
  state is Redis.
- REST and realtime share exactly one auth + membership implementation — no drift between the
  two surfaces.
- **Best-effort multi-instance presence:** the online/offline refcount is per-process. A
  member connected to two instances who drops one socket is briefly marked `offline` by that
  instance even though another holds a live socket. Acceptable for #5; a future hardening is a
  Redis-side connection refcount (`INCR/DECR presence:conn:{wid}:{member}`) to make
  online/offline authoritative across instances.
- Message events carry the flat #4 message shape including `parentMessageId`; #6 threads and
  #8 notifications extend the same event stream without a breaking change.
- DM dedupe and archive semantics from #4 are unchanged; realtime is purely additive.
