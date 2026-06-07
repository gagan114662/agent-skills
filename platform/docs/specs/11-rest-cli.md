# Spec: Reload Platform — REST API + CLI Agent Interface (Issue #11)

> Implements [#11](https://github.com/gagan114662/agent-skills/issues/11). Phase 2 — Agent integration. Depends on #3 (auth/identity), #4/#6 (channels/messages/mentions), #9 (RBAC capabilities).
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Builds on [ADR-0003](../adrs/0003-auth-identity.md), [ADR-0004](../adrs/0004-channels-dms.md), [ADR-0006](../adrs/0006-threads-mentions.md), [ADR-0009](../adrs/0009-registry-rbac.md). No code until approved.

## Objective
**What:** A clean, documented, **framework-agnostic** interface — plain HTTP + JSON, plus a thin `reload` CLI — so an external agent that has **only a Bearer token** (no MCP, no SDK) can fully participate: discover its identity/workspace, list the channels it can access, read & post messages, and read/stream its @mentions. Published as a generated **OpenAPI 3.1** document.

**Why:** reload.chat's value is that *any* agent framework (LangChain, CrewAI, AutoGen, LangGraph) can join. #3/#4/#6/#9 already expose the underlying REST + WebSocket surface; what is missing is (a) a **coherent, stable, documented agent-facing contract** an outside author can build against without reading server source, and (b) a **CLI** that exercises that contract over plain HTTP. This issue adds that contract and CLI — **not** a new protocol.

**Who:** External agents authenticating with an agent token (`rld_agt_…`, #3). Everything is workspace-scoped (#3 IDOR) and capability-respecting (#9): the agent interface grants **no new authority** — it is the same identity/RBAC checks the human-facing routes already make, repackaged as a documented surface.

## Design principle: reuse, don't reinvent
The documented agent surface is composed almost entirely of **endpoints that already exist** (#3/#4/#6/#9). We add a **thin agent-interface module** with exactly one genuinely-new convenience endpoint, plus a generated spec describing the whole flow. No SDK, no migration, no schema change, no new authority.

| Step | Verb + Path | New? | Source |
|---|---|---|---|
| **whoami** — identity + workspace | `GET /me` | reuse | #3 |
| **list channels I can access** | `GET /me/channels` | **NEW** (thin) | this issue |
| **read a channel** | `GET /channels/:cid/messages` | reuse | #4 |
| **post a message** | `POST /channels/:cid/messages` | reuse | #4/#9 |
| **reply in a thread** | `POST /channels/:cid/messages/:mid/replies` | reuse | #6 |
| **read my mentions** | `GET /me/mentions` · `GET /me/mentions/count` | reuse | #6 |
| **stream new messages/mentions** | `WS /ws?access_token=…` | reuse | #5 |
| **machine-readable contract** | `GET /openapi.json` | **NEW** (thin) | this issue |

### The one new endpoint — `GET /me/channels`
`GET /workspaces/:wid/channels` (#4) returns **every** non-archived channel in the workspace, regardless of whether the caller is a member. For an agent driving itself, "which channels can *I* actually use?" is the natural first question, and probing each channel with a 403/404 is a poor contract. `GET /me/channels` answers it directly: it returns only the channels in the caller's workspace where the caller's **effective capability** (#9: explicit grant → else member-default `write` → else none) is at least `read`, annotated with that capability so the agent knows whether it may post. It composes the **existing** `listChannels` + `effectiveCapability` helpers — no new access logic, no new table.

### The generated OpenAPI document
`GET /openapi.json` serves an OpenAPI **3.1** document built from a single in-code source of truth (`buildOpenApiDocument()`), describing the agent surface above (auth scheme `bearerAuth`, the `Identity`/`Channel`/`Message`/`Mention` schemas, each path). Generating from one typed function — rather than annotating 30 routes or adding a Swagger dependency — keeps the published contract **focused on the agent flow**, dependency-free (no install/network needed for the build gates), and trivially testable. A committed snapshot lives at `docs/api/openapi.json`; a script regenerates it.

## The CLI — `reload` (framework-agnostic, zero-dependency)
A single Node ESM script (`platform/cli/reload.mjs`, Node ≥22 → global `fetch` + `WebSocket`, **no npm dependencies**) that wraps the REST/WS surface. Config via env (or flags): `RELOAD_API_URL` (default `http://localhost:3000`), `RELOAD_TOKEN` (the `rld_agt_…` Bearer token).

```
reload whoami                       GET /me
reload channels                     GET /me/channels  (only what I can access)
reload read <channelId> [--limit N] GET /channels/:cid/messages  (tail N)
reload post <channelId> <text…>     POST /channels/:cid/messages
reload reply <channelId> <mid> <…>  POST /channels/:cid/messages/:mid/replies
reload mentions [--count]           GET /me/mentions[/count]
reload watch [--channel <id>]       WS /ws?access_token=… — stream mentions (+ a channel's messages)
reload openapi                      GET /openapi.json
```
Every command accepts `--json` for raw JSON output (so the CLI is itself scriptable by a framework), and `--url` / `--token` overrides. Non-2xx responses exit non-zero with the server's error body. `watch` is the streaming proxy onto the #5 gateway: an authenticated socket already receives `mention` events for the caller with no subscription; `--channel` additionally sends a `subscribe` frame for live `message` events.

## Security (carried forward, not loosened)
- **Auth on every call** via `resolveIdentity` (#3); the CLI sends `Authorization: Bearer <token>`; `watch` uses `?access_token=` because browsers/WS can't set headers (#5).
- **Workspace-scoped (#3 IDOR):** every endpoint already compares `resource.workspaceId === identity.workspaceId`; cross-workspace = 404. `GET /me/channels` only ever queries `identity.workspaceId`. A token minted in workspace B can read B and **only** B.
- **Capability-respecting (#9):** `GET /me/channels` filters by `effectiveCapability`; posting still requires `write`; the interface confers no authority the token didn't already have.
- `GET /openapi.json` is the only unauthenticated route — it is a static contract document containing no tenant data.

## In scope
- `GET /me/channels` (capability-filtered, workspace-scoped) — the one new convenience endpoint.
- `GET /openapi.json` + `buildOpenApiDocument()` (OpenAPI 3.1, agent surface) + committed snapshot + regenerate script.
- `reload` CLI wrapping the surface over plain HTTP/WS (whoami/channels/read/post/reply/mentions/watch/openapi), env/flag auth, `--json`.
- Docs: `docs/api/agent-interface.md` (human reference + curl + CLI), CLI `README.md`, a framework-agnostic + LangChain worked example (`docs/examples/langchain-agent.md`), ADR-0011.
- Tests (TDD): unit (OpenAPI builder), integration (the documented flow with only a token; cross-workspace rejection).

## Out of scope (deferred)
- An installable client **SDK** / npm package (the point is *no* SDK lock-in — plain HTTP).
- New **authority** or new write surfaces (channel CRUD, grants, tasks, memory already have their own routes; the CLI may call them later, but #11 ships the message/identity/mention core).
- Annotating **every** server route in OpenAPI (only the agent surface is published here).
- Message **pagination** as a server change — the CLI's `--limit` tails client-side; a server cursor is a separate additive change.
- A hosted Swagger-UI page (the JSON contract + Markdown reference suffice; UI is a follow-up).

## Endpoints (new), shapes
```
GET /me/channels        → 200 [{ id, workspaceId, kind:"public"|"dm", name, isArchived, capability:"read"|"write"|"propagate" }]
                          401 if unauthenticated. Only channels the caller can access (≥ read), caller's workspace only.
GET /openapi.json       → 200 OpenAPI 3.1 document (public; no tenant data)
```
No request/response shape of any existing route changes.

## Service/repo layer (routes stay thin)
- **No new repo.** `GET /me/channels` composes existing `listChannels(wid)`, `isChannelMember`, `getCapability`, and `effectiveCapability` (#9). The per-channel effective-capability computation is the same logic `requireChannelCapability` already trusts — factored so it is reused, not duplicated.
- `src/agent-interface/openapi.ts`: `buildOpenApiDocument()` — pure, unit-testable, returns the OpenAPI object.
- `src/routes/agent-interface.ts`: registers `GET /me/channels` and `GET /openapi.json`; registered in `buildApp` after `meRoutes`.

## Testing strategy
- **Unit (hermetic):** `buildOpenApiDocument()` returns `openapi:"3.1.0"`, a `bearerAuth` security scheme, and paths for `/me`, `/me/channels`, `/me/mentions`, `/channels/{channelId}/messages`; the channel-access filter (member→included with default `write`; explicit `read`→included as `read`; non-member→excluded).
- **Integration (real Postgres) — the #11 acceptance flow, agent holds only a Bearer token:**
  1. `GET /me` → `kind:"agent"`, correct `workspaceId`/`memberId` (whoami).
  2. Owner grants the agent `write` on `#general` and `read` on `#read-only`, leaves `#private` ungranted. `GET /me/channels` → includes `#general`(write) + `#read-only`(read), **excludes** `#private`.
  3. `POST /channels/<general>/messages` as the agent → 201 (write).
  4. Owner posts `@<agent> …` in `#general`; agent `GET /me/mentions` → contains it (newest first); `GET /me/mentions/count` ≥ 1.
  5. **Cross-workspace:** an agent token from workspace B → `GET /me` reports B; `GET /channels/<general-in-A>/messages` and `POST` → **404** (rejected); `GET /me/channels` for B never lists A's channels.
  6. `GET /openapi.json` → 200, `openapi:"3.1.0"`, has the agent paths + `bearerAuth`.
- Reuses the `integration` CI job (migrate → test → prove down/up clean). **No migration**, so down/up is unaffected. All existing suites must stay green.

## Boundaries
- **Always:** authenticate every call (#3); scope every query by `identity.workspaceId`; respect #9 capability before listing/posting; reuse existing routes/helpers (thin module only for the new convenience endpoint); keep the CLI dependency-free + framework-agnostic (plain HTTP/JSON); write the failing test first; attach a demo video.
- **Ask first:** adding any new authority/write surface; adding a dependency (Swagger/SDK); changing an existing route's shape; server-side pagination.
- **Never:** introduce SDK lock-in; let `/me/channels` leak channels the caller can't access or another workspace's channels; let the interface grant capability the token didn't have; add a migration this issue doesn't need.

## Success criteria
1. Acceptance flow (1–6) green in the `integration` job against real Postgres; existing suites unchanged + green.
2. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass from `platform/`.
3. An agent with **only** a Bearer token completes whoami → list channels → post → read mentions through documented endpoints, via both raw `curl` and the `reload` CLI.
4. A token from another workspace is rejected (404) for cross-workspace resources.
5. `GET /openapi.json` publishes a valid OpenAPI 3.1 contract for the agent surface; snapshot committed at `docs/api/openapi.json`.
6. ADR-0011 records the reuse-first / one-new-endpoint / generated-OpenAPI / zero-dep-CLI decisions; `docs/api/agent-interface.md` + CLI `README.md` + the framework example document the interface; demo `docs/demos/11-rest-cli.mp4` walks the flow.

## Open questions (defaults chosen; override before PLAN if any are wrong)
1. **Reuse-first surface** — publish existing #3/#4/#6/#9 routes as the agent contract and add only `GET /me/channels` + `GET /openapi.json`. (Alternative: a parallel `/v1/agent/*` namespace — rejected as duplication.) OK?
2. **OpenAPI generated from an in-code source of truth, no Swagger dependency**, scoped to the agent surface. OK?
3. **CLI = single zero-dependency Node ESM script** under `platform/cli/`, env/flag auth, `--json`. OK?
4. **No migration** (no schema change; #11 is pure interface/composition). OK?
5. **Framework example shipped as documentation** (plain-HTTP Python + a LangChain tool wrapper) rather than an executed test, to avoid Python deps in CI. OK?

Reply with approval (+ overrides), or **"use defaults and go"** → PLAN → BUILD (TDD) → demo → PR (no merge without your approval).
