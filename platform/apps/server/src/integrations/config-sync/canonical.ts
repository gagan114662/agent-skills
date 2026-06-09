import type { McpServerConfig, ResolvedConfig, SlashCommandConfig } from "../../config/schema.js";

/**
 * The canonical agent-config (#57): one source of truth for the tooling that should follow an agent
 * across harnesses — MCP servers, project slash commands, and skills. It is derived from the resolved
 * layered config (#58), so a deployment edits TOML once and both Claude Code and Codex stay in sync.
 *
 * Note: `mcpServers[*].env` is a list of variable **names** only (per the config schema), so the
 * canonical config — and every artifact rendered from it — is secret-free by construction.
 */
export interface AgentConfig {
  mcpServers: Record<string, McpServerConfig>;
  slashCommands: Record<string, SlashCommandConfig>;
  skills: string[];
}

/** Project the resolved config down to the canonical agent-config synced to each harness. */
export function toAgentConfig(cfg: ResolvedConfig): AgentConfig {
  return {
    mcpServers: cfg.mcpServers,
    slashCommands: cfg.slashCommands,
    skills: cfg.skills,
  };
}
