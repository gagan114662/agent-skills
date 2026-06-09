# Deep dev integrations (#57)

First-class integrations so an agent can **start from an issue, run project tooling, and share its
config across harnesses**. Three surfaces, all on existing seams (ADR-0034). Builds on the real harness
(#50), cloud execution (#25), and layered config (#58).

## 1. Start a session from a GitHub/Linear issue

```http
POST /channels/:cid/agent-sessions/from-issue
{ "ref": "github:acme/web#42", "agentMemberId": "...", "linkBack": true, "instructions": "..." }
→ 202 { id, status, runtime, agentMemberId, issue: { source, ref, url, title } }
```

- **Ref forms:** `github:owner/repo#42`, the shorthand `owner/repo#42`, or `linear:ENG-123`.
- **Read:** the provider fetches the issue (GitHub REST — issues *and* PRs; Linear GraphQL) and the
  title/body/labels/URL are rendered into the agent's task (`buildIssueTask`).
- **Act:** with `"linkBack": true`, a "session started" comment is posted back to the issue
  (best-effort — a failed comment never fails the launch).
- **Auth:** identical to the base launch — write capability on the channel, the target must be an
  in-workspace **agent** (IDOR-checked).
- **Tokens:** `GITHUB_TOKEN` / `LINEAR_API_KEY` are resolved **per-tenant** from `AGENT_SECRETS` (the
  #25 secrets path), used only as the bearer arg, and **never logged**. Unauthenticated reads work for
  public GitHub issues (rate-limited). A provider failure → `502` (never echoed).

## 2. Run a project slash command in a session

Declare commands in `.reload/settings.toml` (the #58 repo/user layer):

```toml
[slashCommands.review]
description = "Review a diff"
prompt = "Review this diff for correctness and security:\n{{args}}"
```

```http
POST /channels/:cid/agent-sessions/slash
{ "command": "/review the auth diff", "agentMemberId": "..." }
→ 202 { id, status, runtime, agentMemberId, command }
```

`{{args}}` is replaced with the caller's args; if a template has no placeholder, non-empty args are
appended. The **template is trusted config**; args are **data** in the prompt (never argv). Unknown
command → `404`.

## 3. Sync agent-config across harnesses (Claude Code ↔ Codex)

One canonical config (`[mcpServers.*]`, `[slashCommands.*]`, `skills` in `.reload/settings.toml`) renders
to both harnesses' native formats:

```http
GET  /me/agent-config           → { mcpServers, slashCommands, skills }
POST /me/agent-config/sync       { "targets": ["claude-code", "codex"] }   (default: both)
  → { targets, artifacts: [ { harness, path, content }, ... ] }
```

| Harness | Artifacts |
|---|---|
| `claude-code` | `.mcp.json`, `.claude/commands/<name>.md` (`$ARGUMENTS`), `.claude/settings.json` |
| `codex` | `~/.codex/config.toml` (`[mcp_servers.*]`), `~/.codex/prompts/<name>.md` |

`/sync` returns a **dry plan**; an operator/CLI materializes it with `applySyncPlan` (path-contained).
MCP `env` is a list of variable **names** — synced artifacts carry `${VAR}` **placeholders**, never the
secret value, so the plan is secret-free by construction.

## Security summary

- Third-party tokens stay on the #25 `SecretsResolver` path: per-tenant, bearer-only, never logged,
  never in config or artifacts.
- Issue/command text is prompt **data** — the injection-safe `$AGENT_TASK` boundary (#50) is unchanged.
- Both session routes reuse the base capability/IDOR gating — no new authority.

## Out of scope (follow-ups)

GitHub Checks/status writes & PR reviews (the seam is shaped for them); webhook-driven auto-start; live
push to a running harness; a settings GUI; Claude Code for Chrome (#56). See ADR-0034.
