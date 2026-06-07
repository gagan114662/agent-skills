# ADR-0018: Web Client — Slack-style, agent-first workspace

- **Status:** Accepted (Gagan pre-approved end-to-end execution — issue #18)
- **Date:** 2026-06-07
- **Context issue:** [#18](https://github.com/gagan114662/agent-skills/issues/18)
- **Builds on:** [ADR-0003](0003-auth-identity.md) (auth), [ADR-0004](0004-channels-dms.md) (channels),
  [ADR-0005](0005-realtime-messaging.md) (/ws gateway), [ADR-0006](0006-threads-mentions.md) (threads + @mentions),
  [ADR-0009](0009-registry-rbac.md) (RBAC)

## Context
#1–#15 built the server: auth, channels/DMs, a realtime WebSocket gateway with Redis fan-out,
threads, @mentions, search, tasks, and a memory graph. Until #18 the only human-facing surface was
a health-probe view. #18 is the first **web client** — a Slack-style workspace, reimagined
**agent-first**, where humans watch and steer while agents work.

Issue #18 is explicitly large and to be split into sub-PRs (`shell+messaging → tasks → memory
graph`). **This PR is the first slice:** auth, channel sidebar, a live message pane, posting,
threads, @mention autocomplete, presence, and surfacing humans **and** agents as first-class
members. Tasks board (#14 UI), memory graph (#15 UI), approval queue, search UI, and notification
inbox are deferred to later sub-PRs. The client **consumes the server REST + WebSocket API exactly
as it exists** — no server changes (the contract is captured in `platform/.context/api-contract.md`).

## Decisions

1. **Keep the existing toolchain; no router, no Redux.** The app stays React 19 + Vite + strict TS.
   State lives in a single in-memory store exposed via `useSyncExternalStore` (`store/store.ts`),
   provided through one React context. With one workspace, one active channel, and an event stream,
   a reducer-style store is simpler than a router + global state library and keeps the bundle small
   (~67 kB gzip). View switches (channel, thread open/closed) are state, not routes.

2. **Proxy REST + `/ws` to the API origin so the httpOnly `rid` cookie just works.** The session
   cookie is httpOnly (JS can't read it) and same-site lax. Rather than juggle CORS + credentials,
   the Vite dev server proxies every API surface (`/auth`, `/me`, `/workspaces`, `/channels`,
   `/healthz`, and the `/ws` upgrade with `ws: true`) to the Fastify origin, so the browser sends
   the cookie automatically on same-origin requests. Production serves the built assets from the API
   origin, so no proxy is needed there. The REST client sets `credentials: "include"` to be explicit.

3. **Realtime + REST reconciliation, dedup by message id.** On selecting a channel the client sends
   `{type:"subscribe",channelId}` and renders `message` events for it; on post it also merges the
   REST response into the store. Both paths upsert by message `id`, so a dropped realtime frame or a
   doubled delivery never duplicates or loses a message. The WebSocket client auto-reconnects with
   capped backoff and re-subscribes tracked channels on every (re)connect. `mention` events feed a
   mention inbox indicator **independent of channel subscription** — the actionable agent signal
   from #6 surfaced for humans as an unread bell.

4. **Agents are first-class members in the UI.** Identity carries `kind: "human" | "agent"` (#2/#3),
   so the client tints agent avatars/authorship, badges agent messages `AGENT`, groups the members
   rail into Agents/People, and marks agents distinctly in @mention autocomplete. This is the
   "agent-first" reframing the issue calls for: an @-mentioned agent is a visible, addressable
   teammate, not a bot bolted on.

5. **Thread replies stay in the thread unless "also sent to channel".** ADR-0006 deliberately keeps
   the server's flat message list inclusive of replies and pushes presentation policy to the client.
   The message pane therefore filters to top-level messages plus replies whose `alsoSentToChannel`
   is true — matching Slack/reload.chat — while the thread panel shows root + replies. This is the
   one place we use `alsoSentToChannel` as render policy rather than server behavior.

6. **Type-safe against a hand-mirrored contract.** The server does not export message/channel/
   identity types from `@reload/shared` (only health types live there). Rather than risk drift by
   adding server-unused types to the shared package, the client keeps a small, documented
   `api/types.ts` mirroring `protocol.ts` + the route shapes, cross-checked against
   `.context/api-contract.md`. Where `@reload/shared` does have a type, it is reused.

## Known server constraints we adapted to (not fixed here — no server change)
Recorded so a later **server** PR can close them:
- **No author display name on messages, and no "member by id" endpoint.** Messages carry only
  `authorMemberId`. The client builds a member directory from member search
  (`/search/members`, ILIKE on `displayName`) merged across a small vowel set to approximate the
  full roster, plus `/me`; unknown authors fall back to a short member-id badge.
  *Recommend: a `GET /workspaces/:wid/members` listing and/or author display name on the message
  payload.*
- **No `createdAt` on the `Message` payload.** The client orders by server return order (the REST
  list is already chronological) and arrival order for realtime; it never invents timestamps.
  *Recommend: add `createdAt` to the server's `messageColumns`.*
- **No per-channel member list.** The members rail is workspace-scoped (directory + the agents
  registry), not per-channel.
- **DMs (`kind:"dm"`, `name:null`) can't be named client-side.** Listed under a generic "Direct
  messages" group; rich DM compose/labeling is deferred.

## Consequences
- The platform gains a usable human surface that is purely additive on the server — zero API
  changes. Every later UI slice (tasks, memory graph, approval queue) renders inside this shell.
- A real correctness fix surfaced during browser verification and was fixed test-first: the
  @mention autocomplete had a **stale-response race** (a slower earlier search could overwrite a
  newer query's results). A monotonic sequence token now discards superseded searches
  (`Composer.race.test.tsx`).
- Coverage: 48 vitest specs across the API client, the `/ws` client (reconnect/re-subscribe),
  the store (dedup, presence, mention inbox, author resolution), and every component. Verified live
  in a browser (sign-in → channels → post → realtime in a second session → thread reply → @mention
  an agent) with screenshots and a walkthrough video; the terminal acceptance trace
  (`scripts/demos/18-web-client.sh`) re-proves the same flow for CI.
- The directory-via-vowel-search is a pragmatic stopgap for the missing list-members endpoint; it
  is encapsulated behind the store and trivially swapped when the server adds a roster endpoint.
