# ADR-0034: Deep Dev Integrations (GitHub/Linear → session, project slash commands, agent-config sync)

- **Status:** Accepted (Gagan approved defaults-and-go — issue #57)
- **Date:** 2026-06-09
- **Context issue:** [#57](https://github.com/gagan114662/agent-skills/issues/57) (Feature phase 4 —
  Real execution & Conductor parity)
- **Builds on:** [ADR-0025](0025-cloud-execution.md) (AgentRuntime / SessionManager / SecretsResolver),
  [ADR-0027](0027-real-agent-harness.md) (the real coding-agent harness + the `$AGENT_TASK` injection
  contract), [ADR-0035](0035-config-layering.md) (layered TOML config),
  [ADR-0009](0009-registry-rbac.md) (channel capabilities), [ADR-0011](0011-rest-cli.md) (the
  framework-agnostic agent surface)

## Context
The platform can run an agent server-side (#25), with a real Claude Code harness (#50), configured by
layered TOML (#58), reachable over MCP (#10) and ACP/A2A (#12). What it still could not do is **plug
into how a team actually works**: start an agent from a GitHub or Linear issue, run a project's own
slash commands, or carry one agent-config across harnesses. Conductor integrates exactly here — open a
workspace from an issue, run project slash commands, and keep skills/slash-commands/MCP in sync between
Claude Code and Codex. This ADR adds those three integration surfaces, each on an existing seam, with
no new authority and no secret ever leaving the #25 path.

## Decisions

1. **Issue → session behind an `IssueProvider` seam (read + act), tokens per-tenant.** One interface —
   `fetchIssue` (read) + `postComment` (act) — with a `GitHubIssueProvider` (REST; `GET
   /repos/{o}/{r}/issues/{n}` serves issues **and** PRs) and a `LinearIssueProvider` (GraphQL, resolving
   an `ENG-123` identifier by team-key + number). Both take an **injectable `fetch`** so unit tests are
   network-free and the SDK-less path stays dependency-light. `POST
   /channels/:cid/agent-sessions/from-issue` parses the ref, **reuses the base launch gating**
   (`gateChannelLaunch`: write capability + archived-409 + in-workspace agent IDOR + the channel-member
   write grant), resolves the provider's token **per-tenant from the #25 `SecretsResolver`**
   (`GITHUB_TOKEN`/`LINEAR_API_KEY`), fetches context, renders it with `buildIssueTask`, and launches the
   existing `SessionManager`. With `linkBack` it posts a best-effort "session started" comment — the
   **act** — which never fails an already-launched session.

2. **Issue/command text is data, never argv.** `buildIssueTask` and the slash-command expander
   interpolate untrusted text into the **task prompt** only — the `AGENT_TASK` env data of the #50
   harness contract — never into the harness command line. The injection-safe `$AGENT_TASK` boundary is
   therefore preserved end-to-end: a hostile issue body or command argument cannot reach a shell. A
   provider failure is surfaced as a generic `502`, never echoed (it could carry request internals), and
   the token never appears in any log or error.

3. **Project slash commands live in the layered config.** A `/`-command is a named **prompt template**
   declared under `[slashCommands.<name>]` (a #58 schema extension). `parseSlashInput` splits
   `name`+`args`; `expandCommand` substitutes `{{args}}`; `SlashCommandRegistry` resolves a name against
   the tenant's resolved config. `POST /channels/:cid/agent-sessions/slash` uses the **same** gating and
   launches the session with the expanded prompt. The **template is trusted config**; the caller's args
   are data — so commands are a project capability, not a client-supplied command.

4. **One canonical agent-config, rendered to each harness (the "sync").** `[mcpServers.*]`,
   `[slashCommands.*]`, and `skills` in the layered config form a single source of truth
   (`AgentConfig`). Pure exporters render it to **Claude Code** (`.mcp.json`, `.claude/commands/<n>.md`
   with `$ARGUMENTS`, `.claude/settings.json`) and **Codex** (`~/.codex/config.toml` with
   `[mcp_servers.*]`, `~/.codex/prompts/<n>.md`) formats that carry the **same** servers, commands, and
   skills. `GET /me/agent-config` returns the canonical config; `POST /me/agent-config/sync` returns a
   dry **`SyncPlan`** (artifacts) which an operator/CLI applies via `applySyncPlan` (injectable, path-
   contained fs). Edit TOML once; both harnesses stay in sync.

5. **No secret in config or artifacts — placeholders only.** An MCP server's `env` is a list of variable
   **names**, never values (a #58 invariant: config is non-secret). Exporters emit `${VAR}` placeholders
   so a `SyncPlan` — returned over HTTP and written to disk — is secret-free by construction. Provider
   tokens stay entirely on the #25 `SecretsResolver` path and are never read from or written to config.

6. **Additive and default-inert.** The three new config fields default empty, so a deployment with no
   `[slashCommands]`/`[mcpServers]`/`skills` behaves exactly as before. The integration routes share the
   existing `SessionManager` and are wired through a `buildApp` `integrations` seam so tests inject fakes
   (a fake `IssueProvider`, an in-memory config loader) with no network and no cloud spend.

## Consequences
- An agent can be started from a real GitHub/Linear issue with the issue's context attached, and
  optionally comment back — proven end-to-end by an integration test (real Postgres/Redis + LocalRuntime,
  fake provider) and unit tests on the providers (fake `fetch`), parsing, and task rendering.
- A project ships its own slash commands in `.reload/settings.toml`; they run in a session — proven by an
  integration test (a `/echo` command runs and the expanded prompt reaches the channel) and unit tests.
- One config renders equivalently to Claude Code and Codex with placeholder-only secrets — proven by unit
  tests asserting the same MCP server/commands/skills in both and no secret value in the plan.
- No new authority: every session launch goes through the same capability/IDOR gating as #25; no new
  table, no new token scope on the platform side.
- Default behavior is unchanged; the new dependency surface is zero (providers use the global `fetch`).

## Security
- **Third-party tokens** are resolved per-tenant from the #25 `SecretsResolver`, used only as the bearer
  arg, and never logged, never in config, never in a sync artifact. A provider error → generic `502`.
- **Injection boundary:** issue/command text is prompt data, never argv; the `$AGENT_TASK` contract (#50)
  is unchanged.
- **Authorization parity:** `from-issue` and `slash` reuse `gateChannelLaunch`, so a cross-tenant channel
  → `404` and a non-agent member → `400` exactly as the base route (covered by an IDOR integration test).
- **No secret leakage via sync:** MCP `env` is names-only; exporters emit `${VAR}`; a unit test asserts no
  secret value appears in a `SyncPlan`.
- **Path containment (writer):** `applySyncPlan` writes only under the harness config root; a crafted
  `..` is rejected.

## Alternatives considered
- **Real GitHub/Linear SDKs:** rejected for this slice — a thin `fetch` adapter behind one interface
  keeps the dependency surface at zero and the test path network-free; the seam can adopt an SDK later
  without changing callers.
- **Writing harness config files directly from `/sync`:** rejected as the default — returning a dry
  `SyncPlan` keeps the server from mutating arbitrary host paths; an operator/CLI opts in via
  `applySyncPlan`.
- **Slash commands as code/plugins:** rejected — config-declared prompt templates keep commands trusted,
  reviewable, and free of a code-execution surface; the args stay data.
- **Webhook-driven auto-start (issue opened → session):** out of scope — this slice is request-driven; a
  webhook receiver is a follow-up on the same provider seam.
- **Claude Code for Chrome:** explicitly out of scope per #57 (ties into #56).

## Follow-ups (deferred)
- GitHub **Checks**/status writes and PR **review** actions (the provider interface is shaped to grow
  `fetchChecks`/`createReview`).
- Webhook receiver for issue/PR events → auto-launch.
- Live config push to a running harness process (today `sync` produces artifacts read on next start).
- A web settings/integration GUI (#51/web reads the same canonical config + plan).
- Thread the synced MCP/skills config into the SandboxRuntime image.
