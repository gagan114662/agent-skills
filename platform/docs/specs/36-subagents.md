# Spec: Reload Platform — Custom Subagents / Agent Personas (@code-reviewer) (Issue #59)

> Implements [#59](https://github.com/gagan114662/agent-skills/issues/59). Feature phase 4 — Real
> execution & Conductor parity.
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Built the agent_skills way — every
> stage is governed by a skill in `skills/`. Builds on [#50/#27](27-real-agent-harness.md) (the real
> Claude Code harness behind a config flag), [#25](25-cloud-execution.md) (`AgentRuntime` /
> `SessionManager` / `AgentJob`), [#12](12-acp-a2a.md) (A2A handoff), [#9](09-registry-rbac.md) (the
> read<write<propagate capability ladder), and [#6](06-threads-mentions.md) (mentions + threads).

## Objective
**What:** Let a workspace **define its own subagents (agent personas)** — each with a persona
**system prompt**, an **allowed-tools** scope, and an optional **model** — and **invoke** one from a
session by **@mention** (e.g. `@code-reviewer`). The subagent runs the real harness scoped to its
tools/permissions, and its result is **threaded back into the parent message** that invoked it. A
built-in **`code-reviewer`** persona ships as the reference.

**Why:** Conductor supports custom **subagents / agent personas** (code-reviewer, test automation,
etc.) invokable inside a session. We have A2A handoff (#12) — an agent can create a task assigned to
another agent — but no **user-defined, @-mentionable** subagent with its **own instructions and tool
scope**. Personas are how a team encodes reusable expertise ("review my diff", "write the tests")
that any member can summon in-channel without standing up a new agent integration each time.

**Who:** Workspace members who **define** personas (a one-time setup, like registering an agent) and
any member who **invokes** one in a channel they can act in. Under the hood it is the existing
`SessionManager` running the existing harness as the persona's own agent member.

### Acceptance criteria (from #59)
1. A workspace member can **define** a subagent: persona name/handle, system prompt, allowed tools,
   optional model. The persona is **@-mentionable** (it materializes as an agent member with that
   handle) and is workspace-scoped (#3 IDOR).
2. A member can **invoke** a defined subagent by **@mention** on a message; the subagent runs the
   real harness **scoped to its tools/permissions** and **its allowed-tools cannot be widened** by
   the invoker.
3. The subagent's output is **threaded back under the invoking message** (returned into the parent
   thread), posted as the **persona's own** member identity.
4. **Subagent cannot exceed its RBAC scope / cannot escalate privileges** (#9): the persona runs as
   its **own** agent member, bounded by **that member's** channel grants; invoking is itself a
   **delegation** that requires the invoker to hold `propagate` on the channel; and the requested
   tool set can only **narrow** the persona's ceiling, never widen it.
5. A built-in **`code-reviewer`** persona is seedable as the reference subagent.
6. `pnpm -C platform typecheck && lint && test && build` green; integration green.
7. ADR-0036 + this spec + demo script `scripts/demos/36-subagents.sh` (the runnable proof; recorded
   video pending); PR links #59; **not** merged
   (approved by @gagan114662 on the video).

### In scope
- **A `subagents/` module** in `apps/server/src/subagents/`:
  - `scope.ts` — **pure** logic (no I/O, unit-tested):
    - `resolveToolScope(personaTools: string[], requested?: string[]): string[]` — the **intersection**:
      when `requested` is given the result is `requested ∩ personaTools` (the invoker may *narrow*),
      otherwise it is `personaTools`. **Never a superset of `personaTools`** — this is the tool-ceiling
      guarantee. De-duped, order-stable, empty `personaTools` ⇒ empty (no tools).
    - `personaHarnessEnv(persona, scope): Record<string,string>` — maps a persona + resolved scope to
      the harness env contract: `{ AGENT_APPEND_SYSTEM_PROMPT, AGENT_ALLOWED_TOOLS }` (only set when
      non-empty). This is **data**, threaded to the harness exactly like `AGENT_TASK` (see #50) — never
      argv — so a persona prompt cannot inject shell.
    - `validatePersonaInput(input)` — non-secret, bounded: a required handle matching
      `/^[A-Za-z0-9._-]+$/` (so it is a valid #6 mention token), a non-empty system prompt, an
      `allowedTools` array of tool-name strings (`/^[A-Za-z0-9_-]+$/`, the Claude Code `--allowedTools`
      charset), and an optional model string. Rejects with a clear, content-free error.
  - `service.ts` — `SubagentService.invoke(...)` — the **invocation orchestrator** (the security gate +
    the `SessionManager.launch` call). Pure deps injected (capability checker, persona lookup, member
    lookup, launcher) so it is unit-testable without a DB.
- **Persona registry** — `agent_personas` table + repository (copy the #25 `agent_sessions`
  schema+migration+repo trio):
  - Columns: `id`, `workspace_id` (FK → workspaces, cascade), `agent_member_id` (FK → members,
    cascade — the materialized, @-mentionable agent member), `agent_id` (FK → agents, cascade — for
    deactivation), `name` (the handle), `system_prompt`, `allowed_tools jsonb` (string[]),
    `model` (nullable), `is_builtin boolean default false`, `created_by_member_id` (FK → members,
    set null), `created_at`. Indexed by workspace; `name` unique per workspace (one handle per tenant).
  - **Defining a persona** = `createAgentWithToken(...)` (existing #3 repo — mints the agent member +
    token) **+** an `agent_personas` row in one repository call. Reusing agent creation means the
    persona flows through every existing path (mentions, channels, sessions, A2A) for free.
- **Invocation surface** — `routes/subagents.ts`:
  - `POST /workspaces/:workspaceId/personas` — define a persona (human-auth, like agent registration).
    Returns the persona + the agent token (shown once).
  - `GET  /workspaces/:workspaceId/personas` — list the workspace's personas.
  - `POST /workspaces/:workspaceId/personas/:personaId/deactivate` — deactivate (reuses #9
    `deactivateAgent` on the underlying agent; the persona stops resolving/being mentionable).
  - `POST /channels/:channelId/personas/:personaId/invoke` — **invoke** a subagent in a channel.
    Body `{ task, messageId?, tools? }`. `messageId` (the invoking @mention message) becomes the
    **thread root**; `tools` may only narrow the persona's allowed tools. Returns the launched
    `{ sessionId }`.
- **@mention path** — `messaging/subagent-mentions.ts`: `personaMentionsOnMessage(messageId)` reuses
  the #6 `listMentionsOnMessage` + persona lookup to find any persona agent members @-mentioned on a
  message. The invoke route accepts `messageId` and, when given, **asserts the persona is actually
  mentioned on it** before threading the result under it (mention-driven, not arbitrary).
- **Harness threading** (#50 seam) — `runtime/harness.ts`: the `claude-code` command gains two
  **env-gated** flags via bash parameter expansion —
  `${AGENT_APPEND_SYSTEM_PROMPT:+--append-system-prompt "$AGENT_APPEND_SYSTEM_PROMPT"}` and
  `${AGENT_ALLOWED_TOOLS:+--allowedTools "$AGENT_ALLOWED_TOOLS"}`. When the env vars are unset (every
  non-persona session, and the `demo` harness) the flags vanish — **behavior is unchanged**. Values
  are double-quoted env references, injection-safe by the same construction as `AGENT_TASK`.
- **SessionManager seam** (#25) — `runtime/manager.ts`: `LaunchInput` gains optional
  `parentMessageId?` (thread the session's posts under the invoking message) and
  `harnessEnv?: Record<string,string>` (merged into the job env alongside `AGENT_TASK`). When absent,
  the manager behaves exactly as today (its own started message as the thread root, `{ AGENT_TASK }`
  only) — **existing sessions/tests unchanged**.
- **Built-in `code-reviewer`** — a seed helper `seedBuiltinPersonas(workspaceId, createdByMemberId)`
  that defines a `code-reviewer` persona (a code-review system prompt + a read-mostly tool scope:
  `["Read","Grep","Glob","Bash"]`) idempotently. Used by the demo and exposable via a
  `POST .../personas/seed-builtins` admin route.
- **Docs/examples** — `.env.example` already documents the harness flag (#50); this issue adds the
  ADR, the spec, the demo script, and a short README section on defining/invoking a persona.

### Out of scope (deferred / documented-not-automated)
- **A marketplace of shared agents** (explicitly out of scope in #59) — personas are per-workspace.
- **Auto-firing on every @mention** — invocation is an explicit call (the route), optionally bound to
  a mentioned message. Wiring personas into the #17 autonomy engine so a mention *auto*-dispatches is
  a documented follow-up; this issue ships the deterministic, gated invoke path the engine would call.
- **A web UI for defining/invoking personas** — follow-up under #18/#51 (the web client will call the
  same routes). The demo drives the REST API + CLI.
- **Per-tool capability rows** (`resource_type='tool'` in the #9 `permissions` table) — the tool
  scope is enforced at the **harness** boundary (`--allowedTools`) for this issue; promoting tools to
  first-class RBAC resources is a documented follow-up. Channel/privilege escalation **is** enforced
  via the existing ladder (see Security).
- **Sub-subagents (a persona invoking a persona)** — a persona session *can* still use A2A handoff
  (#12) to create a task for another agent; a synchronous nested invoke is deferred.

## The persona model
```
AgentPersona                         // a row in agent_personas (+ a materialized agent member)
  id, workspaceId
  agentMemberId   // the @-mentionable members.id (kind='agent') — this is who the session runs AS
  agentId         // the agents.id (for #9 deactivation)
  name            // the @handle, unique per workspace, /^[A-Za-z0-9._-]+$/
  systemPrompt    // appended to the harness system prompt (--append-system-prompt)
  allowedTools    // string[] tool ceiling (--allowedTools); [] = no tools
  model?          // optional model override (--model)
  isBuiltin       // true for seeded reference personas (e.g. code-reviewer)
  createdByMemberId?, createdAt

definePersona(workspaceId, { name, systemPrompt, allowedTools, model? }, createdByMemberId)
  -> createAgentWithToken(...)  +  insert agent_personas  (one repo call)  -> { persona, token }

invoke(channelId, personaId, { task, messageId?, tools? }, invoker)
  1. requireChannelCapability(invoker, channelId, "propagate")     // delegation needs propagate
  2. persona = getPersonaInChannelWorkspace(personaId, invoker.workspaceId)   // 404 cross-tenant/inactive
  3. require persona.agentMember has >= "write" on channelId        // persona is permitted there
  4. if messageId: require persona is @-mentioned on it             // mention-driven threading
  5. scope = resolveToolScope(persona.allowedTools, tools)          // narrow-only ceiling
  6. SessionManager.launch({ channelId, agentMemberId: persona.agentMemberId,
       createdByMemberId: invoker.memberId, task, parentMessageId: messageId,
       harnessEnv: personaHarnessEnv(persona, scope) })
  -> { sessionId }   // runs server-side, streams result threaded under messageId as the persona
```

## Security
The non-escalation guarantee is the heart of #59. It is enforced by **reusing the #9 capability
ladder**, not by inventing a new RBAC system:

- **A subagent runs as its own identity, never the invoker's.** The launched session's
  `agentMemberId` is the **persona's** member. So every downstream check the persona faces is bounded
  by **that member's** grants — invoking a persona can never give it access the persona's member does
  not already have. (Test: a persona with no grant on a private channel is rejected at invoke time.)
- **Invoking is delegation → requires `propagate`.** A member may only summon a subagent in a channel
  where they themselves hold `propagate` (the #9 cap that means "may hand work to others"), mirroring
  the A2A handoff trust boundary. A `read`/`write`-only member gets 403. (Test.)
- **The persona must itself be permitted in the channel.** The persona's agent member needs `>= write`
  on the target channel; otherwise invoke is 403. This stops an invoker from steering a persona into a
  channel the persona has no business in. (Test.)
- **Tool ceiling is narrow-only.** `resolveToolScope` returns `requested ∩ personaTools`; a request
  for tools outside the persona's `allowedTools` is silently dropped, never granted — the resolved set
  is always a subset of the persona's ceiling. The ceiling is threaded to the harness as
  `--allowedTools`, which restricts the tools the agent process may use. (Unit test asserts widening is
  impossible.)
- **Injection-safe persona config.** System prompt and tools reach the harness **only via env**
  (`AGENT_APPEND_SYSTEM_PROMPT`, `AGENT_ALLOWED_TOOLS`), double-quoted in the `bash -lc` template
  exactly like `AGENT_TASK` — a hostile persona prompt cannot break out into the command line. Tool
  names are validated to `/^[A-Za-z0-9_-]+$/` at define time (defense in depth).
- **No secrets in personas.** A persona carries only a prompt + tool names + an optional model — all
  non-secret. Secrets stay on the #25 `SecretsResolver` path and continue to be redacted from streamed
  output (the persona session goes through the same `makeRedactor` path as every session).
- **Tenant isolation.** Every persona read is workspace-scoped (#3 IDOR): a persona id from another
  workspace is a 404, never invokable. Deactivation reuses #9 `deactivateAgent` — a deactivated
  persona stops resolving as a member (un-mentionable) and its tokens are revoked.

## Testing strategy
- **Unit (hermetic, no DB — `pnpm test`):**
  - **Tool ceiling (`scope.ts`):** `resolveToolScope(["Read","Grep"], ["Read","Bash"])` ⇒ `["Read"]`
    (Bash dropped); `resolveToolScope(["Read","Grep"])` ⇒ `["Read","Grep"]`; the result is **always a
    subset** of the persona tools (property-style: a random `requested` never widens); `[]` persona ⇒
    `[]`. De-dup + order-stable.
  - **Harness env (`scope.ts`):** `personaHarnessEnv` sets `AGENT_APPEND_SYSTEM_PROMPT` and
    `AGENT_ALLOWED_TOOLS` (comma-joined) only when non-empty; empty scope omits `AGENT_ALLOWED_TOOLS`.
  - **Validation (`scope.ts`):** a bad handle / empty prompt / non-string tool / a tool with a shell
    metacharacter is rejected with a clear error; a valid input passes.
  - **Harness flags (`harness.test.ts`):** the `claude-code` spec includes the two `${VAR:+...}`
    env-gated flags and remains `bash -lc <single arg>` (the task still cannot reach argv); the `demo`
    spec is unchanged; with the env vars unset the command is a no-op for them.
  - **Service (`service.ts`) with fakes:** invoke calls the launcher with `agentMemberId =
    persona.agentMemberId`, `parentMessageId = messageId`, and `harnessEnv` from the resolved scope;
    an invoker without `propagate` ⇒ 403 (launcher never called); a persona without `write` on the
    channel ⇒ 403; a `tools` request outside the ceiling is narrowed before launch.
  - **Manager seam (`manager.test.ts`):** with `parentMessageId` set, streamed lines + the started
    message thread under it; with `harnessEnv` set, the job env carries `AGENT_TASK` **and** the
    persona vars; with both absent, behavior is byte-for-byte today's (existing tests stay green).
- **Integration (real Postgres/Redis, LocalRuntime + `demo` harness — `pnpm test:integration`):**
  - **Define + invoke happy path:** create a workspace + a human owner, `POST .../personas`
    (code-reviewer), post a message `@code-reviewer review this diff`, `POST
    .../personas/:id/invoke` with that `messageId`, `join` the session, assert (a) a session row
    `completed`, (b) the persona's output is posted **as the persona member** **threaded under the
    invoking message**.
  - **Non-escalation #1 (delegation):** an invoker with only `write` on the channel ⇒ invoke 403.
  - **Non-escalation #2 (persona scope):** a persona whose member is not granted on a private channel
    ⇒ invoke 403.
  - **Tenant isolation:** a persona id from another workspace ⇒ 404 on invoke.
  - **Deactivation:** after deactivate, the persona no longer resolves as a mention and invoke 404s.
  - Per-workspace isolation via unique slug (the established shared-Postgres trick); cleanup by slug.
- The demo (`scripts/demos/36-subagents.sh`, recorded as the PR video) defines `@code-reviewer`,
  posts a diff with the mention, invokes it, and shows the review threaded back under the message —
  plus a denied invoke proving the RBAC scope holds.

## Boundaries
- **Always:** run a subagent as its **own** agent member; require `propagate` to delegate; require the
  persona to hold `write` on the target channel; resolve tools as **narrow-only**; thread persona
  config through **env**, never argv; validate persona input (handle/prompt/tool charset); default the
  new `LaunchInput` fields OFF so existing behavior is unchanged; write the failing test first; attach
  the demo video.
- **Ask first:** auto-firing a subagent on every @mention (autonomy wiring); promoting tools to
  first-class #9 RBAC resources; nested synchronous sub-subagent invokes; changing the delegation cap
  from `propagate`.
- **Never:** let an invoker widen a persona's tool ceiling or grant it a capability the persona's
  member lacks; run a persona as the invoker's identity; put a secret in a persona; interpolate a
  persona prompt/task into argv; ship a marketplace; merge without approval + video.

## Success criteria
1. A workspace member defines an @-mentionable `code-reviewer` persona with a prompt + tool scope.
2. Invoking it by @mention runs the real harness scoped to its tools and threads the result back under
   the invoking message, posted as the persona (integration).
3. The subagent cannot exceed its RBAC scope: narrow-only tools (unit), `propagate`-gated delegation
   (integration), persona-scoped channel access (integration), tenant isolation (integration).
4. Built-in `code-reviewer` seeds idempotently.
5. `pnpm typecheck && lint && test && build` green; integration green.
6. ADR-0036 + this spec + demo script `scripts/demos/36-subagents.sh` (the runnable proof; recorded video pending); PR links #59; **not** merged.

## Plan (atomic)
1. `agent_personas` schema + `drizzle/0059_subagents.sql` (+ `.down.sql`) + `db/repositories/personas.ts`
   (`definePersona`, `getPersona`, `getPersonaByHandle`, `listPersonas`, `effectiveChannelCapabilityFor`
   helper) — *slice 1*.
2. `subagents/scope.ts` — `resolveToolScope`, `personaHarnessEnv`, `validatePersonaInput` (pure) — *slice 1*.
3. `runtime/harness.ts` env-gated flags; `runtime/manager.ts` `LaunchInput.parentMessageId` +
   `harnessEnv` threading — *slice 2*.
4. `subagents/service.ts` `SubagentService.invoke` (capability gates + launch); `routes/subagents.ts`
   (define/list/deactivate/invoke); `messaging/subagent-mentions.ts`; `seedBuiltinPersonas`; wire into
   `app.ts` — *slice 3*.
5. Tests (unit per slice; integration in slice 3), demo script, README section — *with each slice*.
6. ADR-0036 + demo recording + PR (links #59, not merged) — *ship*.

> Approach: defaults-and-go per the maintainer's mandate (DEFINE → PLAN → BUILD with TDD → demo → PR;
> reviewed and merged by @gagan114662 on the video). No merge without approval.
