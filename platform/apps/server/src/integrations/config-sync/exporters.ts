import type { McpServerConfig } from "../../config/schema.js";
import type { AgentConfig } from "./canonical.js";

/** The harnesses we can sync to. */
export type HarnessTarget = "claude-code" | "codex";

/** One file to write for a harness. `path` is relative to that harness's config root. */
export interface SyncArtifact {
  harness: HarnessTarget;
  path: string;
  content: string;
}

export interface SyncPlan {
  artifacts: SyncArtifact[];
}

/** Render an MCP `env` name-list as a placeholder map (`VAR → "${VAR}"`) — never a secret value. */
function placeholderEnv(env: string[] | undefined): Record<string, string> {
  return Object.fromEntries((env ?? []).map((name) => [name, "${" + name + "}"]));
}

/** Convert the canonical `{{args}}` placeholder to the harness-native `$ARGUMENTS` token. */
function toHarnessPrompt(prompt: string): string {
  return prompt.replace(/\{\{\s*args\s*\}\}/g, "$ARGUMENTS");
}

/**
 * Claude Code format:
 *   - `.mcp.json`                     — `{ mcpServers: { name: { command,args,env } | { type:"http",url } } }`
 *   - `.claude/commands/<name>.md`    — a slash command (front-matter `description` + `$ARGUMENTS` body)
 *   - `.claude/settings.json`         — `{ skills: [...] }`
 */
export function renderClaudeCode(cfg: AgentConfig): SyncArtifact[] {
  const artifacts: SyncArtifact[] = [];

  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(cfg.mcpServers)) {
    mcpServers[name] = server.url
      ? { type: "http", url: server.url, env: placeholderEnv(server.env) }
      : { command: server.command ?? "", args: server.args ?? [], env: placeholderEnv(server.env) };
  }
  artifacts.push({
    harness: "claude-code",
    path: ".mcp.json",
    content: JSON.stringify({ mcpServers }, null, 2) + "\n",
  });

  for (const [name, cmd] of Object.entries(cfg.slashCommands)) {
    const front = cmd.description ? `---\ndescription: ${cmd.description}\n---\n\n` : "";
    artifacts.push({
      harness: "claude-code",
      path: `.claude/commands/${name}.md`,
      content: front + toHarnessPrompt(cmd.prompt) + "\n",
    });
  }

  artifacts.push({
    harness: "claude-code",
    path: ".claude/settings.json",
    content: JSON.stringify({ skills: cfg.skills }, null, 2) + "\n",
  });

  return artifacts;
}

/** TOML string-escape for the small set of values we emit (no control chars expected). */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function codexMcpBlock(name: string, server: McpServerConfig): string {
  const lines = [`[mcp_servers.${name}]`];
  if (server.command) lines.push(`command = ${tomlString(server.command)}`);
  if (server.args?.length) lines.push(`args = ${tomlArray(server.args)}`);
  if (server.url) lines.push(`url = ${tomlString(server.url)}`);
  const env = placeholderEnv(server.env);
  if (Object.keys(env).length) {
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [k, v] of Object.entries(env)) lines.push(`${k} = ${tomlString(v)}`);
  }
  return lines.join("\n");
}

/**
 * Codex format:
 *   - `~/.codex/config.toml`        — `[mcp_servers.<name>]` blocks + a `[reload] skills = [...]` table
 *   - `~/.codex/prompts/<name>.md`  — a custom prompt (`$ARGUMENTS` body), Codex's slash-command analog
 */
export function renderCodex(cfg: AgentConfig): SyncArtifact[] {
  const artifacts: SyncArtifact[] = [];

  const blocks: string[] = [];
  for (const [name, server] of Object.entries(cfg.mcpServers)) {
    blocks.push(codexMcpBlock(name, server));
  }
  // Skills are not a native Codex concept; carry them under a namespaced table so the sync is
  // lossless and the equivalence is checkable.
  blocks.push(`[reload]\nskills = ${tomlArray(cfg.skills)}`);
  artifacts.push({
    harness: "codex",
    path: "~/.codex/config.toml",
    content: blocks.join("\n\n") + "\n",
  });

  for (const [name, cmd] of Object.entries(cfg.slashCommands)) {
    artifacts.push({
      harness: "codex",
      path: `~/.codex/prompts/${name}.md`,
      content: toHarnessPrompt(cmd.prompt) + "\n",
    });
  }

  return artifacts;
}

const RENDERERS: Record<HarnessTarget, (cfg: AgentConfig) => SyncArtifact[]> = {
  "claude-code": renderClaudeCode,
  codex: renderCodex,
};

/** Build a sync plan for the requested target harnesses (defaults to both). */
export function planSync(
  cfg: AgentConfig,
  targets: HarnessTarget[] = ["claude-code", "codex"],
): SyncPlan {
  return { artifacts: targets.flatMap((t) => RENDERERS[t](cfg)) };
}
