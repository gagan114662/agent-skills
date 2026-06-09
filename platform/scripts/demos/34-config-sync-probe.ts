/**
 * Agent-config sync probe for the #57 demo. Loads the layered config (so it picks up the repo-scope
 * `.reload/settings.toml` the demo writes), projects it to the canonical AgentConfig, and renders the
 * sync plan for both harnesses. Prints one JSON line summarizing the equivalence + placeholder safety:
 *
 *   { mcpServers, slashCommands, skills, claudeHasGithub, codexHasGithub, hasPlaceholder, hasSecretValue }
 *
 *   tsx scripts/demos/34-config-sync-probe.ts [workspaceId]
 */
import { loadConfig } from "../../apps/server/src/config/loader.js";
import { toAgentConfig } from "../../apps/server/src/integrations/config-sync/canonical.js";
import { planSync } from "../../apps/server/src/integrations/config-sync/exporters.js";

const workspaceId = process.argv[2] || undefined;
const cfg = loadConfig(workspaceId);
const agentConfig = toAgentConfig(cfg);
const plan = planSync(agentConfig);

const claude = plan.artifacts.filter((a) => a.harness === "claude-code").map((a) => a.content).join("\n");
const codex = plan.artifacts.filter((a) => a.harness === "codex").map((a) => a.content).join("\n");
const all = plan.artifacts.map((a) => a.content).join("\n");

process.stdout.write(
  JSON.stringify({
    mcpServers: Object.keys(agentConfig.mcpServers),
    slashCommands: Object.keys(agentConfig.slashCommands),
    skills: agentConfig.skills,
    claudeHasGithub: claude.includes("github"),
    codexHasGithub: codex.includes("[mcp_servers.github]"),
    hasPlaceholder: all.includes("${GITHUB_TOKEN}"),
    // a "real" secret value would be a token like ghp_… — assert none leaked into any artifact
    hasSecretValue: /ghp_[A-Za-z0-9]/.test(all) || /lin_api_[A-Za-z0-9]/.test(all),
  }) + "\n",
);
