# Spec: Reload Platform — Web Client (Issue #18)

> Implements [#18](https://github.com/gagan114662/agent-skills/issues/18). Phase 4 — UI & polish.
> Depends on #5 (realtime), #6 (threads + @mentions), #4 (channels/DMs), #3 (auth), #9 (RBAC).
> Lifecycle: this is the **DEFINE** artifact (`spec-driven-development`). No code until approved.

## Objective

**What:** A Slack-style web client — reimagined **agent-first** — where humans watch and steer while
agents work. Sign in, browse a channel sidebar, read a live message pane, post messages, reply in
threads, @mention humans **and** agents, and see who's present (humans and agents are both members).

**Why:** #1–#15 built the server (auth, channels, realtime gateway, threads, mentions, search,
tasks, memory). Until now there is no human-facing surface — the only UI is a health probe view.
#18 turns the platform into something a person can actually use: it consumes the existing REST +
WebSocket API **as-is** and renders the reload.chat workspace experience in the browser.

**Who:** Humans steering an agent workspace; this PR is the foundation every later UI slice
(tasks board, memory graph, approval queue) renders inside.

### Scope of THIS PR (the `shell + messaging` slice)

Issue #18 is explicitly large and is to be **split into sub-PRs** (`shell+messaging → tasks →
memory graph`). This PR delivers the first, load-bearing slice — atomic tasks 1 & 2 of the issue plan:

- **In scope:** workspace shell (channel sidebar + members/presence rail + message pane +
  composer); auth (login / signup, session via the `rid` cookie, `/me` bootstrap, logout);
  channels list + create; live message stream over the #5 `/ws` gateway; posting messages;
  **threads** panel (#6); **@mention autocomplete** (#6) resolving humans and agents; **presence**
  (online/away/offline) over the gateway; surfacing **agents as first-class members** (an agents
  rail + agent-tinted authorship and mentions).
- **Out of scope (deferred to later sub-PRs / issues, per the issue's own split):** tasks board +
  detail (#14 UI), memory graph view (#15 UI), notification inbox, full search UI, approval queue,
  multi-workspace switch, DM composition UX. (DM channels that already exist are listed read-only;
  rich DM creation/naming is deferred — see *Known server constraints*.)

**Success looks like:** a person opens the app, signs in, sees the workspace's channels and members
(humans + agents), posts in a channel and watches it appear live in a second browser session,
opens a thread and replies, and `@mentions` an agent — all against the unmodified server.

### Acceptance criteria (testable; subset of #18 mapped to this slice)
1. **Auth:** an unauthenticated visit shows a sign-in screen; logging in (or signing up) lands in
   the workspace; reload preserves the session (cookie); logout returns to sign-in.
2. **Channels:** the sidebar lists the workspace's channels; selecting one loads its messages;
   creating a channel adds it to the sidebar and selects it.
3. **Live messaging:** posting a message in channel C appears in **another** signed-in session
   subscribed to C without a refresh (realtime over `/ws`).
4. **Threads:** opening a message's thread shows root + replies; posting a reply appears in the
   thread (and, when "also send to channel" is set, in the channel).
5. **@mentions:** typing `@` in the composer shows an autocomplete of workspace members (humans and
   agents, distinguished); selecting one inserts `@displayName`; the mentioned agent/human is
   notified (a `mention` event drives a notification indicator).
6. **Agent-first members:** the members rail lists humans and agents with a kind badge and a live
   presence dot; agent authorship/mentions are visually distinct.

### Out-of-scope (explicitly deferred)
- Any **server** change. We consume the REST + WS contract documented in
  `platform/.context/api-contract.md` exactly as it exists.
- Tasks board/detail, memory graph, approval queue, notification inbox, full search results UI,
  workspace switching — later sub-PRs.

## Known server constraints (consumed as-is — drove these decisions)

The client adapts to the **existing** contract; none of these justify a server change in this PR.
(Recorded in ADR-0018; a follow-up server PR is recommended where noted.)

1. **No `createdAt` on the `Message` payload.** REST + realtime `Message` =
   `{ id, channelId, authorMemberId, parentMessageId, alsoSentToChannel, body }`. The client orders
   by server return order (REST list is already chronological) and by arrival for realtime; it does
   **not** invent timestamps. *(Recommend: add `createdAt` to `messageColumns` server-side later.)*
2. **No author display name on messages, and no "member by id" endpoint.** Messages carry
   `authorMemberId` only. The client resolves names via a **member directory** built from member
   search (`GET …/search/members`, ILIKE on `displayName`) merged across a small vowel set to
   approximate "all members", plus `/me`. Unknown authors fall back to a short member-id badge.
   *(Recommend: a `GET /workspaces/:wid/members` listing + author-name on message payloads.)*
3. **No "list channel members" endpoint.** The members rail is workspace-scoped (humans+agents via
   the directory; agents also enumerated via `GET /workspaces/:wid/agents`), not per-channel.
4. **`rid` is `httpOnly`.** JS can't read it; the browser sends it automatically. Therefore the dev
   server **proxies** REST + the `/ws` upgrade to the Fastify origin so everything is same-origin
   and the cookie rides along (no CORS/credentials juggling).
5. **DMs (`kind:"dm"`, `name:null`) can't be named client-side** (no member list per channel). They
   are listed in a "Direct messages" group with a generic label; rich DM UX is deferred.

## Architecture

Keep the existing toolchain (Vite + React 19 + strict TS). **No router, no Redux** — a single
in-memory store via `useSyncExternalStore`. New runtime deps kept minimal; tests via Vitest +
Testing Library + jsdom (added as devDeps).

```
apps/web/src/
  api/
    types.ts        # wire types mirroring .context/api-contract.md (Identity, Channel, Message,
                    # MentionEvent, ServerEvent, ClientCommand, MemberHit, AgentProfile)
    client.ts       # typed fetch wrapper (credentials: include) — auth, channels, messages,
                    # threads, members, agents, mentions
    realtime.ts     # WebSocket client: connect /ws, auto-reconnect, subscribe(channelId),
                    # dispatch message/mention/presence/ready/error to listeners
  store/
    store.ts        # useSyncExternalStore store: identity, channels, activeChannel,
                    # messages-by-channel, thread, directory, presence, mention inbox
    directory.ts    # member directory: warmRoster() + resolveAuthor(id) + searchMembers(q)
  components/
    AuthGate.tsx        # login/signup; bootstraps /me
    Workspace.tsx       # shell layout (sidebar | main | members rail)
    ChannelSidebar.tsx  # channels + DMs + create channel
    MessagePane.tsx     # header + message list + composer
    MessageList.tsx / MessageItem.tsx
    Composer.tsx        # textarea + @mention autocomplete
    MentionAutocomplete.tsx
    ThreadPanel.tsx     # root + replies + reply composer
    MembersRail.tsx     # humans + agents + presence
    PresenceDot.tsx / KindBadge.tsx / Avatar.tsx
  App.tsx               # AuthGate → Workspace
  main.tsx
```

**Realtime discipline (mirrors server):** on selecting a channel, send `{type:"subscribe",
channelId}`; render `message` events for the active/subscribed channels; render `mention` events
into a mention inbox indicator regardless of subscription; render `presence` events into the
directory. The socket auto-reconnects with backoff and re-subscribes the active channel. REST
post-response is merged into the store (dedup by message `id`) so the UI is correct even if a
realtime frame is dropped.

## PLAN — atomic tasks (each independently buildable & testable)

1. **Toolchain:** add Vitest + Testing Library + jsdom; vite dev proxy for REST + `/ws`; test
   scripts + `tsconfig` include for tests.
2. **API layer:** `api/types.ts`, `api/client.ts` (typed REST), `api/realtime.ts` (WS) — unit tests
   with mocked `fetch` / `WebSocket`.
3. **Store + directory:** `store.ts`, `directory.ts` — reducer/dispatch unit tests (message dedup,
   presence merge, mention inbox, author resolution + fallback).
4. **Auth UI:** `AuthGate` — login/signup/logout, `/me` bootstrap; tests.
5. **Shell + channels:** `Workspace`, `ChannelSidebar`, create-channel; tests.
6. **Messages + composer:** `MessagePane`, `MessageList`, `MessageItem`, `Composer`; post + realtime
   append; tests.
7. **Threads:** `ThreadPanel`; tests.
8. **@mention autocomplete:** `MentionAutocomplete` + composer integration; tests.
9. **Members/presence:** `MembersRail`, `PresenceDot`, `KindBadge`; tests.

## VERIFY

- **Gates (from `platform/`):** `pnpm typecheck && pnpm lint && pnpm build` (apps/web must build);
  `pnpm --filter @reload/web test` green.
- **Browser (`browser-testing-with-devtools`):** run Postgres+Redis + server + web; drive the core
  flow (sign in → see channels → post → realtime update in a 2nd session → thread reply → @mention
  an agent); capture screenshots as evidence.
- **Demo:** script at `scripts/demos/18-web-client.sh`; video at `docs/demos/18-web-client.mp4` via
  `bash scripts/record-demo.sh 18-web-client`.

## Definition of Done
- Spec (this file) committed and approved before code.
- Tests written first (red → green), incrementally.
- Reviewed per `code-review-and-quality` + `security-and-hardening`; UI verified in-browser with
  evidence.
- **ADR-0018** records the non-obvious decisions (proxy-for-cookie, directory-via-search, no-router
  store, realtime+REST reconciliation, server-constraint adaptations).
- Shipped as **one PR** linking #18 with the demo video; reviewed & merged by @gagan114662.
