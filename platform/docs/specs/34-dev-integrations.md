# Spec: Reload Platform — Deep Dev Integrations (GitHub/Linear → session, project slash commands, agent-config sync) (Issue #57)

> Implements [#57](https://github.com/gagan114662/agent-skills/issues/57). Feature phase 4 — Real
> execution & Conductor parity.
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Built the agent_skills way — every
> stage governed by a skill in `skills/`. Builds on [#50](27-real-agent-harness.md) (the real
> coding-agent harness), [#25](25-cloud-execution.md) (`AgentRuntime`, `SessionManager`, the
> per-tenant `SecretsResolver`), and [#58](35-config-layering.md) (layered TOML config).

## Objective
**What:** Give an agent **first-class dev integrations** so it can _start from an issue, use project
tooling, and share its config across harnesses_. Three surfaces, all on existing seams:

1. **Issue → session** — launch a `SessionManager` session **from a GitHub or Linear issue/PR**, with
   the issue's title/body/labels/URL fetched and attached as the agent's task context (read), and an
   optional status comment posted back to the issue (act).
2. **Project slash commands** — named, project-defined commands (`/review`, `/fix`, …) declared in the
   layered config that **expand to a task prompt** and run in a session.
3. **Agent-config sync** — one canonical agent-config (MCP servers + slash commands + skills) in the
   layered config that **renders to both Claude Code and Codex formats**, so the same tooling follows
   the agent across harnesses.

**Why:** Conductor integrates deeply with dev tooling — open a workspace straight from a GitHub/Linear
issue, run project slash commands, and keep skills/slash-commands/MCP in sync between Claude Code and
Codex. The platform already has the execution spine (#25/#50), config layering (#58), MCP (#10), and
ACP/A2A (#12), but an agent still cannot **start from an issue**, **run a project command**, or **carry
its config to another harness**. These are the integration surfaces that turn "an agent that runs" into
"an agent that plugs into how a team actually works."

**Who:** A developer who wants to kick off an agent from an issue they're triaging; a team that ships
project slash commands as part of its repo; and an operator running the same agent under both Claude
Code and Codex who needs one config, not two drifting copies.

### Acceptance criteria (from #57 — BUILD/TDD)
1. **Start a session from a GitHub/Linear issue with context attached** — `POST
   /channels/:cid/agent-sessions/from-issue` fetches the referenced issue, builds a context-rich task,
   and launches a session; the session's output reflects the issue's title/body (proven end-to-end with
   the demo harness echoing `AGENT_TASK`).
2. **A project slash command runs in a session** — a `/`-command declared in the repo config expands to
   its prompt template (with caller args as data) and launches a session via `POST
   /channels/:cid/agent-sessions/slash`.
3. **Config (skills/MCP) syncs between two harnesses** — one canonical `AgentConfig` renders to a Claude
   Code artifact set **and** a Codex artifact set that carry the **same** MCP servers, slash commands,
   and skills (equivalence asserted), with **no secret values inlined**.
4. **Security:** third-party tokens are resolved per-tenant via the #25 `SecretsResolver`, injected only
   where needed, **never logged**, and **never written into config or exported artifacts** (placeholders
   only).
5. `pnpm -C platform typecheck && lint && test && build` green; integration green.
6. ADR-0034 + this spec + demo `docs/demos/34-dev-integrations.mp4`; PR links #57; **not** merged.

### In scope
- **`integrations/issues/`** — issue providers behind one seam:
  - `types.ts` — `IssueRef`, `IssueContext`, the `IssueProvider` interface, the pure `parseIssueRef()`
    (`github:owner/repo#123`, shorthand `owner/repo#123`, `linear:ENG-123`) and `buildIssueTask()`
    (renders an `IssueContext` into the task prompt). Pure + hermetic.
  - `github.ts` — `GitHubIssueProvider`: `fetchIssue` (GitHub REST `GET /repos/{o}/{r}/issues/{n}` —
    works for issues **and** PRs) + `postComment` (`POST …/issues/{n}/comments`). Uses an **injectable
    `fetch`** (default global) and a per-call bearer token; the SDK-less `fetch` path keeps it
    dependency-free and lazy (no network unless called).
  - `linear.ts` — `LinearIssueProvider`: `fetchIssue` + `postComment` via the Linear **GraphQL** API,
    same injectable-`fetch` + per-call token shape.
  - `registry.ts` — `resolveIssueProvider(ref, providers)` picks the adapter by `ref.source`; a default
    registry wires the two real adapters.
- **Route — issue→session** (`routes/integrations.ts`): `POST /channels/:cid/agent-sessions/from-issue`
  `{ ref, agentMemberId, linkBack?, instructions? }`. Reuses the **exact** gating of
  `agent-sessions.ts` (write capability, archived-channel 409, in-workspace agent IDOR, channel-member +
  capability grant), resolves the tenant's provider token via `SecretsResolver`, fetches context, builds
  the task (issue context + optional extra `instructions`), launches via the injected `SessionManager`,
  and — when `linkBack` — posts a "session started" comment back to the issue (the **act**). 202 on
  success, mirroring the base launch route.
- **`integrations/commands/`** — project slash commands:
  - `slash.ts` — `parseSlashInput()` (`"/review the auth diff"` → `{ name, args }`), `expandCommand()`
    (template + `{{args}}` / `{{arg}}` substitution → prompt), and `SlashCommandRegistry` built from the
    resolved config's `slashCommands`. Unknown command → typed `UnknownCommandError`. Pure + hermetic.
- **Route — slash→session** (`routes/integrations.ts`): `POST /channels/:cid/agent-sessions/slash`
  `{ command, agentMemberId }` — same gating as above; expands the command against the tenant's config
  and launches a session with the expanded prompt. Unknown command → 404; the command **template** is
  trusted config, the caller's **args** are data (injected into the prompt text, never into argv).
- **`integrations/config-sync/`** — agent-config across harnesses:
  - `canonical.ts` — `AgentConfig { mcpServers, slashCommands, skills }` derived from the resolved
    layered config (one source of truth).
  - `exporters.ts` — pure renderers: `renderClaudeCode(cfg)` → `{ "./.mcp.json", "./.claude/commands/<n>.md",
    "./.claude/settings.json" }`; `renderCodex(cfg)` → `{ "~/.codex/config.toml", "~/.codex/prompts/<n>.md" }`.
    `planSync(cfg, targets)` returns a `SyncPlan` (a list of `{ harness, path, content }` artifacts).
    **MCP env values are emitted as `${VAR}` placeholders**, never the secret itself.
  - `writer.ts` — `applySyncPlan(plan, { writeFile, mkdir })` materializes artifacts through **injectable**
    fs ops (tests never touch disk); path-guarded under the harness config roots.
- **Route — config sync** (`routes/integrations.ts`): `GET /me/agent-config` (the canonical config for
  the caller's tenant) and `POST /me/agent-config/sync` `{ targets?: ("claude-code"|"codex")[] }` → the
  `SyncPlan` (dry plan by default; the CLI/operator applies it). Read uses the existing agent identity
  (#3); no new authority.
- **Config schema (#58 extension)** — add to `config/schema.ts`/`ResolvedConfig`:
  `slashCommands?: Record<string,{ description?, prompt }>`, `mcpServers?: Record<string,{ command?, args?,
  url?, env? (var-name list) }>`, `skills?: string[]`. All optional; defaults `{}`/`[]` so existing
  deployments are unchanged.
- **Wiring** — `routes/integrations.ts` registered in `app.ts`; default deps built from `loadConfig`,
  `EnvSecretsResolver`, and the default issue registry. `buildApp` gains an injectable `integrations`
  seam so route tests pass fakes (no network, fake `SessionManager`).
- **Examples + docs** — `docs/integrations/dev-integrations.md`; `.reload/settings.toml.example` gains a
  `[slashCommands.*]`, `[mcpServers.*]`, and `skills` example; `.env.example` documents
  `GITHUB_TOKEN`/`LINEAR_API_KEY` as **per-tenant secrets** (via `AGENT_SECRETS`), not config.

### Out of scope (deferred / documented-not-automated)
- **Claude Code for Chrome** — explicitly out of scope per #57 (ties into #56).
- **GitHub Checks / status writes & PR review actions** — the provider seam is shaped to grow a
  `fetchChecks`/`createReview`; this PR ships issue/PR **read + comment**. Checks are a documented
  follow-up on the same interface.
- **Webhook-driven auto-start** (issue opened → session) — this PR is request-driven; a webhook receiver
  is a follow-up.
- **Live config push to a running harness process** — `sync` produces artifacts the harness reads on
  next start; hot-reloading a live Claude Code/Codex process is out of scope.
- **A settings/integration GUI** — follow-up under #51/web (the web client reads the same canonical
  config + sync plan later).
- **Secrets in config** — never. Provider tokens and MCP secrets stay on the #25 `SecretsResolver` path;
  exporters emit placeholders only.

## The model
```
IssueRef    { source: "github"|"linear"; owner?; repo?; number?; key?; raw }
IssueContext{ source; ref; id; title; body; url; state; labels[]; author? }
IssueProvider {
  source
  fetchIssue(ref, token?) -> IssueContext              // read
  postComment(ref, token?, body) -> { url }            // act
}
parseIssueRef("github:acme/web#42" | "acme/web#42" | "linear:ENG-7") -> IssueRef
buildIssueTask(ctx, instructions?) -> string           // prompt injected as AGENT_TASK

SlashCommand { name; description?; prompt }            // from config.slashCommands
parseSlashInput("/review the diff") -> { name:"review", args:"the diff" }
expandCommand(cmd, args) -> string                     // {{args}} substitution
SlashCommandRegistry.get(name) -> SlashCommand | throws UnknownCommandError

AgentConfig { mcpServers; slashCommands; skills }       // from ResolvedConfig
renderClaudeCode(cfg) -> Artifact[]                      // .mcp.json + .claude/commands + settings
renderCodex(cfg)      -> Artifact[]                      // ~/.codex/config.toml + prompts
planSync(cfg, targets) -> { artifacts: Artifact[] }     // Artifact { harness; path; content }
```

### Issue → session flow
```
POST /channels/:cid/agent-sessions/from-issue { ref, agentMemberId, linkBack?, instructions? }
  requireIdentity → requireChannelCapability(write) → archived? 409
  target = getWorkspaceMember(agentMemberId, workspaceId); must be kind=agent   // IDOR
  ref     = parseIssueRef(ref)                                                   // 400 on bad ref
  token   = (await secrets.resolve(workspaceId))[GITHUB_TOKEN|LINEAR_API_KEY]    // per-tenant, never logged
  ctx     = provider.fetchIssue(ref, token)                                      // read; 502 on provider error
  task    = buildIssueTask(ctx, instructions)
  addChannelMember + grantCapability(write)  (same as base launch)
  session = sessionManager.launch({ …, task })
  if linkBack: provider.postComment(ref, token, "🤖 Reload session <id> started …")  // act, best-effort
  → 202 { id, status, runtime, agentMemberId, issue: { source, ref, url, title } }
```

### Slash command flow
```
POST /channels/:cid/agent-sessions/slash { command, agentMemberId }
  …same identity/capability/IDOR gating…
  { name, args } = parseSlashInput(command)
  cmd  = SlashCommandRegistry(loadConfig(workspaceId).slashCommands).get(name)   // 404 if unknown
  task = expandCommand(cmd, args)
  → launch (202)   // template is trusted config; args are data in the prompt, never argv
```

### Config sync flow
```
GET  /me/agent-config            -> AgentConfig (canonical, for caller's tenant)
POST /me/agent-config/sync { targets? } -> SyncPlan { artifacts:[{harness,path,content}] }
  cfg = loadConfig(workspaceId); canonical = toAgentConfig(cfg)
  plan = planSync(canonical, targets ?? ["claude-code","codex"])
  // dry plan returned; an operator/CLI calls applySyncPlan to write the files
```

## Security
- **Third-party tokens stay on the secrets path.** `GITHUB_TOKEN` / `LINEAR_API_KEY` are resolved
  **per-tenant** from the #25 `SecretsResolver` at request time, passed only as the provider's bearer
  arg, and **never logged** (provider errors are surfaced as a generic 502; the token never appears in
  the message). They are **never** read from or written to the config loader.
- **No secret leakage via sync.** Exporters render MCP `env` as `${VAR}` placeholders — the secret value
  is never present in any artifact returned by `/sync` or written by the writer. A unit test asserts no
  secret-looking value appears in a `SyncPlan`.
- **Command/issue text is data, not code.** Slash templates and issue context are interpolated into the
  **task prompt** (the `AGENT_TASK` env data of #50), never into argv. The harness command stays trusted
  config; the injection-safe `$AGENT_TASK` contract (#50) is unchanged, so hostile issue/command text
  cannot reach a shell.
- **Same gating as base launch.** Both session routes reuse `requireChannelCapability`, the archived-409,
  and the in-workspace agent IDOR check — a cross-tenant channel or foreign agent is rejected exactly as
  in `agent-sessions.ts`. No new authority is conferred.
- **Provider robustness.** A provider HTTP error / non-2xx / malformed body becomes a typed
  `IssueProviderError` → 502, never a crash and never a leak of request internals. `linkBack`/`postComment`
  is best-effort: a failed comment never fails an already-launched session.
- **Path containment (writer).** `applySyncPlan` writes only under the resolved Claude Code / Codex config
  roots; artifact paths are derived from the harness layout, not from caller input.

## Testing strategy
- **Unit (hermetic, no DB — `pnpm test`):**
  - **`parseIssueRef`**: `github:owner/repo#42`, bare `owner/repo#42`, `linear:ENG-7`; rejects garbage,
    cross-source confusion, and missing numbers with a clear error.
  - **`buildIssueTask`**: includes title, URL, body, labels, and appended `instructions`; truncates an
    over-long body deterministically.
  - **`GitHubIssueProvider` / `LinearIssueProvider`** with an **injected fake `fetch`**: builds the right
    URL/headers/body, maps the response to `IssueContext`, sends the bearer token; a non-2xx response
    throws `IssueProviderError` **without** the token in the message; `postComment` posts to the right
    endpoint.
  - **`parseSlashInput` / `expandCommand` / `SlashCommandRegistry`**: parses name+args; `{{args}}`
    substitution; unknown command throws `UnknownCommandError`; an empty registry rejects everything.
  - **Exporters**: `renderClaudeCode` + `renderCodex` from one `AgentConfig` produce artifacts that carry
    the **same** MCP server names, slash command names, and skills (the "sync" equivalence); MCP `env`
    appears only as `${VAR}` placeholders; `planSync` honors a `targets` subset.
  - **No secret leakage**: given an `AgentConfig` whose MCP env names a secret var, the `SyncPlan` JSON
    contains the placeholder and not the secret value.
  - **`applySyncPlan`** with injected fs ops: writes each artifact to its harness path; creates parent
    dirs; never writes outside the roots.
- **Integration (real Postgres/Redis, LocalRuntime — `pnpm test:integration`):**
  - **issue→session**: `buildApp` with a **fake `IssueProvider`** (returns a canned issue, no network) +
    a LocalRuntime `SessionManager` whose demo/echo harness prints `AGENT_TASK`; `POST …/from-issue`
    returns 202 and the channel ends up with messages containing the **issue title** — proving the
    context reached the session. `linkBack` records a `postComment` call on the fake (the act). A bad ref
    → 400; cross-workspace channel → 404 (IDOR parity).
  - **slash→session**: with a repo-scope `slashCommands` config and the echo harness, `POST …/slash`
    `{ command: "/echo hello world" }` runs and the channel output contains the expanded prompt; unknown
    command → 404.
  - **config sync route**: `GET /me/agent-config` returns the canonical config; `POST /me/agent-config/sync`
    returns a plan with both harnesses' artifacts carrying the same MCP server.
- The demo (`scripts/demos/34-dev-integrations.sh`, recorded as the PR video) shows: an issue → a running
  session with the issue's context, a project slash command running, and one config syncing to both
  Claude Code and Codex artifact sets.

## Boundaries
- **Always:** reuse the base-launch gating (capability + archived + IDOR); resolve provider tokens
  per-tenant from `SecretsResolver` and keep them out of logs/config/artifacts; treat issue/command text
  as prompt data, never argv; keep providers behind an injectable `fetch` so tests are network-free;
  default the new config fields empty so existing deployments are unchanged; write the failing test
  first; attach the demo video.
- **Ask first:** adding token-bearing **write** actions beyond `postComment` (e.g. creating PRs/branches,
  merging, status checks); auto-starting sessions from webhooks; writing harness config files by default
  (vs returning a dry plan).
- **Never:** read or persist a provider token via the config loader; inline a secret into a sync artifact;
  interpolate issue/command text into a shell command; launch into a channel without the same capability
  check as the base route; merge without approval + video.

## Success criteria
1. `POST …/from-issue` launches a session whose context reflects the issue (integration).
2. A project `/`-command expands and runs in a session (integration).
3. One `AgentConfig` renders to equivalent Claude Code **and** Codex artifacts with placeholder-only
   secrets (unit).
4. Provider tokens are per-tenant, never logged, never in config/artifacts (unit + review).
5. `pnpm typecheck && lint && test && build` green; integration green.
6. ADR-0034 + this spec + demo `docs/demos/34-dev-integrations.mp4`; PR links #57; **not** merged.

## Plan (atomic)
1. `integrations/issues/*` (types+parse+buildTask, GitHub, Linear, registry) + `from-issue` route — *slice 1*.
2. config schema `slashCommands`; `integrations/commands/slash.ts`; `slash` route — *slice 2*.
3. config schema `mcpServers`+`skills`; `integrations/config-sync/*` (canonical, exporters, writer);
   `/me/agent-config` + `/sync` routes — *slice 3*.
4. Wire `routes/integrations.ts` into `app.ts`; `buildApp` `integrations` seam; defaults — *with the slices*.
5. Tests (unit + integration), `.reload`/`.env` examples, `docs/integrations/dev-integrations.md` — *with each slice*.
6. ADR-0034 + demo + PR — *ship*.

> Approach: defaults-and-go per the maintainer's mandate (DEFINE → PLAN → BUILD with TDD → demo → PR;
> reviewed and merged by @gagan114662 on the video). No merge without approval.
