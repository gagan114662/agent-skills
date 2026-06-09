import { describe, expect, it } from "vitest";
import {
  parseSlashInput,
  expandCommand,
  SlashCommandRegistry,
  UnknownCommandError,
} from "../../src/integrations/commands/slash.js";

describe("parseSlashInput (#57)", () => {
  it("splits the command name from its args", () => {
    expect(parseSlashInput("/review the auth diff")).toEqual({ name: "review", args: "the auth diff" });
  });

  it("handles a bare command with no args", () => {
    expect(parseSlashInput("/ship")).toEqual({ name: "ship", args: "" });
  });

  it("tolerates a missing leading slash and extra whitespace", () => {
    expect(parseSlashInput("  fix   the bug  ")).toEqual({ name: "fix", args: "the bug" });
  });

  it("rejects an empty command", () => {
    expect(() => parseSlashInput("/")).toThrow();
    expect(() => parseSlashInput("   ")).toThrow();
  });
});

describe("expandCommand (#57)", () => {
  it("substitutes {{args}} in the template", () => {
    const cmd = { name: "review", prompt: "Review this: {{args}}. Be thorough." };
    expect(expandCommand(cmd, "the auth diff")).toBe("Review this: the auth diff. Be thorough.");
  });

  it("appends args when the template has no placeholder", () => {
    const cmd = { name: "fix", prompt: "Fix the failing tests." };
    expect(expandCommand(cmd, "in the parser")).toBe("Fix the failing tests.\n\nin the parser");
  });

  it("leaves a no-arg template untouched", () => {
    const cmd = { name: "ship", prompt: "Run the release checklist." };
    expect(expandCommand(cmd, "")).toBe("Run the release checklist.");
  });
});

describe("SlashCommandRegistry (#57)", () => {
  const registry = new SlashCommandRegistry({
    review: { description: "Review a diff", prompt: "Review: {{args}}" },
    ship: { prompt: "Ship it" },
  });

  it("gets a command by name", () => {
    expect(registry.get("review")).toMatchObject({ name: "review", prompt: "Review: {{args}}" });
  });

  it("throws UnknownCommandError for an unknown command", () => {
    expect(() => registry.get("nope")).toThrow(UnknownCommandError);
  });

  it("lists all commands", () => {
    expect(registry.list().map((c) => c.name).sort()).toEqual(["review", "ship"]);
  });

  it("an empty registry rejects everything", () => {
    expect(() => new SlashCommandRegistry({}).get("anything")).toThrow(UnknownCommandError);
  });
});
