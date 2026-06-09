import { describe, expect, it } from "vitest";
import { toAgentConfig, type AgentConfig } from "../../src/integrations/config-sync/canonical.js";
import {
  renderClaudeCode,
  renderCodex,
  planSync,
} from "../../src/integrations/config-sync/exporters.js";
import { applySyncPlan } from "../../src/integrations/config-sync/writer.js";
import { CONFIG_DEFAULTS } from "../../src/config/schema.js";

const cfg: AgentConfig = {
  mcpServers: {
    github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: ["GITHUB_TOKEN"] },
  },
  slashCommands: {
    review: { description: "Review a diff", prompt: "Review this diff: {{args}}" },
  },
  skills: ["test-driven-development", "code-review-and-quality"],
};

describe("toAgentConfig (#57)", () => {
  it("derives the canonical config from a resolved config", () => {
    const resolved = { ...CONFIG_DEFAULTS, skills: ["a"], mcpServers: { x: { url: "http://h" } } };
    const ac = toAgentConfig(resolved);
    expect(ac.skills).toEqual(["a"]);
    expect(ac.mcpServers).toEqual({ x: { url: "http://h" } });
    expect(ac.slashCommands).toEqual({});
  });
});

describe("config sync exporters (#57)", () => {
  it("renders Claude Code artifacts carrying the MCP server, command, and skills", () => {
    const arts = renderClaudeCode(cfg);
    const paths = arts.map((a) => a.path);
    expect(paths).toContain(".mcp.json");
    expect(paths.some((p) => p.includes(".claude/commands/review"))).toBe(true);
    const blob = arts.map((a) => a.content).join("\n");
    expect(blob).toContain("github");
    expect(blob).toContain("test-driven-development");
    // Claude Code slash commands use $ARGUMENTS, not the canonical {{args}}.
    const reviewDoc = arts.find((a) => a.path.includes("commands/review"))!;
    expect(reviewDoc.content).toContain("$ARGUMENTS");
    expect(reviewDoc.content).not.toContain("{{args}}");
  });

  it("renders Codex artifacts carrying the same MCP server, command, and skills", () => {
    const arts = renderCodex(cfg);
    expect(arts.some((a) => a.path.includes("config.toml"))).toBe(true);
    expect(arts.some((a) => a.path.includes("prompts/review"))).toBe(true);
    const blob = arts.map((a) => a.content).join("\n");
    expect(blob).toContain("github");
    expect(blob).toContain("test-driven-development");
    expect(blob).toContain("[mcp_servers.github]");
  });

  it("THE SYNC: one config renders equivalently to both harnesses", () => {
    const claude = renderClaudeCode(cfg).map((a) => a.content).join("\n");
    const codex = renderCodex(cfg).map((a) => a.content).join("\n");
    for (const token of ["github", "test-driven-development", "code-review-and-quality"]) {
      expect(claude).toContain(token);
      expect(codex).toContain(token);
    }
  });

  it("emits MCP secret env as a ${VAR} placeholder — never an inlined value", () => {
    const plan = planSync(cfg, ["claude-code", "codex"]);
    const blob = plan.artifacts.map((a) => a.content).join("\n");
    expect(blob).toContain("${GITHUB_TOKEN}");
    // The canonical config stores env var NAMES only, so no value can leak; assert the placeholder
    // form is present in both harnesses' MCP config.
    expect(plan.artifacts.filter((a) => a.content.includes("${GITHUB_TOKEN}")).length).toBeGreaterThanOrEqual(2);
  });

  it("planSync honors a targets subset", () => {
    const plan = planSync(cfg, ["codex"]);
    expect(plan.artifacts.every((a) => a.harness === "codex")).toBe(true);
  });
});

describe("applySyncPlan (#57)", () => {
  it("writes each artifact through injected fs ops and creates parent dirs", async () => {
    const writes: Record<string, string> = {};
    const mkdirs: string[] = [];
    const plan = planSync(cfg, ["claude-code"]);
    await applySyncPlan(plan, {
      root: "/home/agent",
      writeFile: (p, c) => {
        writes[p] = c;
        return Promise.resolve();
      },
      mkdir: (p) => {
        mkdirs.push(p);
        return Promise.resolve();
      },
    });
    expect(Object.keys(writes).length).toBe(plan.artifacts.length);
    // every write is rooted under the provided root (no escape)
    expect(Object.keys(writes).every((p) => p.startsWith("/home/agent"))).toBe(true);
    expect(mkdirs.length).toBeGreaterThan(0);
  });
});
