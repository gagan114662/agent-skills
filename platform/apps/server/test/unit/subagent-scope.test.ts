import { describe, expect, it } from "vitest";
import {
  resolveToolScope,
  personaHarnessEnv,
  validatePersonaInput,
  PersonaValidationError,
} from "../../src/subagents/scope.js";

describe("subagent tool scope (#59)", () => {
  describe("resolveToolScope — narrow-only tool ceiling", () => {
    it("returns the persona's tools when no request is made", () => {
      expect(resolveToolScope(["Read", "Grep"])).toEqual(["Read", "Grep"]);
    });

    it("intersects a request with the persona ceiling (invoker may narrow)", () => {
      expect(resolveToolScope(["Read", "Grep", "Bash"], ["Read", "Bash"])).toEqual(["Read", "Bash"]);
    });

    it("drops requested tools outside the ceiling — never widens", () => {
      expect(resolveToolScope(["Read", "Grep"], ["Read", "Write", "Bash"])).toEqual(["Read"]);
    });

    it("an empty persona ceiling yields no tools regardless of the request", () => {
      expect(resolveToolScope([], ["Read", "Bash"])).toEqual([]);
    });

    it("the resolved set is ALWAYS a subset of the persona ceiling (no escalation)", () => {
      const ceiling = ["Read", "Grep", "Glob"];
      const hostile = ["Read", "Write", "Bash", "Edit", "Grep", "NetworkAccess"];
      const resolved = resolveToolScope(ceiling, hostile);
      for (const tool of resolved) expect(ceiling).toContain(tool);
    });

    it("de-dupes and preserves ceiling order (deterministic, ceiling-ordered)", () => {
      expect(resolveToolScope(["Read", "Grep", "Read"], ["Grep", "Read", "Grep"])).toEqual([
        "Read",
        "Grep",
      ]);
    });
  });

  describe("personaHarnessEnv — env-only persona config", () => {
    it("maps prompt + resolved tools to the harness env contract", () => {
      const env = personaHarnessEnv(
        { systemPrompt: "You review code.", model: null },
        ["Read", "Grep"],
      );
      expect(env.AGENT_APPEND_SYSTEM_PROMPT).toBe("You review code.");
      expect(env.AGENT_ALLOWED_TOOLS).toBe("Read,Grep");
    });

    it("omits AGENT_ALLOWED_TOOLS when the resolved scope is empty (no tool restriction var)", () => {
      const env = personaHarnessEnv({ systemPrompt: "Talk only.", model: null }, []);
      expect(env.AGENT_ALLOWED_TOOLS).toBeUndefined();
      expect(env.AGENT_APPEND_SYSTEM_PROMPT).toBe("Talk only.");
    });

    it("sets AGENT_SKILLS to the comma-joined skill ids (#155)", () => {
      const env = personaHarnessEnv({ systemPrompt: "x", model: null }, ["Read"], [
        "lens/knowledge",
        "lens/runbook",
      ]);
      expect(env.AGENT_SKILLS).toBe("lens/knowledge,lens/runbook");
    });

    it("omits AGENT_SKILLS when the agent has no skill kit (unchanged behavior)", () => {
      const env = personaHarnessEnv({ systemPrompt: "x", model: null }, ["Read"]);
      expect(env.AGENT_SKILLS).toBeUndefined();
    });

    it("drops a hostile skill id (shell-unsafe) — defense in depth like tool names (#155)", () => {
      const env = personaHarnessEnv({ systemPrompt: "x", model: null }, [], [
        "ok/skill",
        "bad; rm -rf /",
        "  ",
      ]);
      expect(env.AGENT_SKILLS).toBe("ok/skill");
    });
  });

  describe("validatePersonaInput — bounded, non-secret, mention-safe", () => {
    it("accepts a valid persona and normalizes tools", () => {
      const v = validatePersonaInput({
        name: "code-reviewer",
        systemPrompt: "Review diffs.",
        allowedTools: ["Read", "Grep"],
        model: "claude-opus-4-8",
      });
      expect(v.name).toBe("code-reviewer");
      expect(v.allowedTools).toEqual(["Read", "Grep"]);
      expect(v.model).toBe("claude-opus-4-8");
    });

    it("rejects a handle that is not a valid mention token", () => {
      expect(() =>
        validatePersonaInput({ name: "code reviewer!", systemPrompt: "x", allowedTools: [] }),
      ).toThrow(PersonaValidationError);
    });

    it("rejects an empty system prompt", () => {
      expect(() =>
        validatePersonaInput({ name: "rev", systemPrompt: "   ", allowedTools: [] }),
      ).toThrow(PersonaValidationError);
    });

    it("rejects a tool name with a shell metacharacter (defense in depth)", () => {
      expect(() =>
        validatePersonaInput({ name: "rev", systemPrompt: "x", allowedTools: ["Read; rm -rf /"] }),
      ).toThrow(PersonaValidationError);
    });
  });
});
