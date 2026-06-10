import { describe, expect, it } from "vitest";
import {
  decodeClaudeCodeLine,
  decodeCodexLine,
  harnessLineDecoder,
} from "../../src/runtime/stream-json.js";

describe("claude-code stream-json decoder (#81)", () => {
  it("renders an assistant text event as readable channel text and preserves the raw event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "I'll fix the bug now." }] },
      session_id: "abc",
    });
    const decoded = decodeClaudeCodeLine(line);
    expect(decoded.display).toEqual(["I'll fix the bug now."]);
    // raw event preserved for run-log / turns consumers
    expect((decoded.raw as { type: string }).type).toBe("assistant");
  });

  it("surfaces a tool_use block as a readable tool-call line", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la", description: "list" } }],
      },
    });
    const decoded = decodeClaudeCodeLine(line);
    expect(decoded.display).toHaveLength(1);
    expect(decoded.display[0]).toContain("🔧");
    expect(decoded.display[0]).toContain("Bash");
    expect(decoded.display[0]).toContain("ls -la");
  });

  it("renders both text and tool_use blocks from a single assistant event in order", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me check the files." },
          { type: "tool_use", name: "Read", input: { file_path: "src/index.ts" } },
        ],
      },
    });
    const decoded = decodeClaudeCodeLine(line);
    expect(decoded.display[0]).toBe("Let me check the files.");
    expect(decoded.display[1]).toContain("Read");
    expect(decoded.display[1]).toContain("src/index.ts");
  });

  it("renders a successful result event as its final summary text", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Fixed the parser and added a test.",
    });
    const decoded = decodeClaudeCodeLine(line);
    expect(decoded.display).toEqual(["Fixed the parser and added a test."]);
  });

  it("flags an error result event", () => {
    const line = JSON.stringify({ type: "result", is_error: true, result: "max turns exceeded" });
    const decoded = decodeClaudeCodeLine(line);
    expect(decoded.display[0]).toContain("⚠️");
    expect(decoded.display[0]).toContain("max turns exceeded");
  });

  it("suppresses non-renderable events (system init) from the channel but keeps the raw event", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", model: "claude", tools: ["Bash"] });
    const decoded = decodeClaudeCodeLine(line);
    expect(decoded.display).toEqual([]);
    expect((decoded.raw as { type: string }).type).toBe("system");
  });

  it("passes a non-JSON stdout line through verbatim (warnings still surface), with no raw event", () => {
    const decoded = decodeClaudeCodeLine("warning: deprecated flag");
    expect(decoded.display).toEqual(["warning: deprecated flag"]);
    expect(decoded.raw).toBeNull();
  });

  it("emits nothing for a blank line", () => {
    expect(decodeClaudeCodeLine("   ")).toEqual({ display: [], raw: null });
  });
});

describe("codex exec --json decoder (#50)", () => {
  it("renders an agent_message item as readable channel text and preserves the raw event", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "I'll fix the parser now." },
    });
    const decoded = decodeCodexLine(line);
    expect(decoded.display).toEqual(["I'll fix the parser now."]);
    expect((decoded.raw as { type: string }).type).toBe("item.completed");
  });

  it("surfaces a command_execution item as a readable tool-call line", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "i2", type: "command_execution", command: "pnpm test", exit_code: 0, status: "completed" },
    });
    const decoded = decodeCodexLine(line);
    expect(decoded.display).toHaveLength(1);
    expect(decoded.display[0]).toContain("🔧");
    expect(decoded.display[0]).toContain("pnpm test");
  });

  it("surfaces a file_change item as a readable tool-call line naming the changed path", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        id: "i3",
        type: "file_change",
        status: "completed",
        changes: [{ path: "src/parser.ts", kind: "update" }],
      },
    });
    const decoded = decodeCodexLine(line);
    expect(decoded.display[0]).toContain("🔧");
    expect(decoded.display[0]).toContain("src/parser.ts");
  });

  it("flags a top-level error event", () => {
    const line = JSON.stringify({ type: "error", message: "rate limit exceeded" });
    const decoded = decodeCodexLine(line);
    expect(decoded.display[0]).toContain("⚠️");
    expect(decoded.display[0]).toContain("rate limit exceeded");
  });

  it("suppresses lifecycle/reasoning events from the channel but keeps the raw event", () => {
    for (const ev of [
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 10 } },
      { type: "item.completed", item: { type: "reasoning", text: "thinking…" } },
    ]) {
      const line = JSON.stringify(ev);
      const decoded = decodeCodexLine(line);
      expect(decoded.display).toEqual([]);
      expect((decoded.raw as { type: string }).type).toBe(ev.type);
    }
  });

  it("passes a non-JSON stdout line through verbatim, with no raw event", () => {
    const decoded = decodeCodexLine("warning: experimental json output");
    expect(decoded.display).toEqual(["warning: experimental json output"]);
    expect(decoded.raw).toBeNull();
  });

  it("emits nothing for a blank line", () => {
    expect(decodeCodexLine("   ")).toEqual({ display: [], raw: null });
  });
});

describe("harnessLineDecoder factory (#81, #50)", () => {
  it("returns the claude-code decoder for the claude-code harness", () => {
    const decode = harnessLineDecoder("claude-code");
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    expect(decode(line).display).toEqual(["hi"]);
  });

  it("returns the codex decoder for the codex harness (#50)", () => {
    const decode = harnessLineDecoder("codex");
    const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } });
    expect(decode(line).display).toEqual(["done"]);
  });

  it("returns a verbatim pass-through for the demo harness — never parses JSON (unchanged)", () => {
    const decode = harnessLineDecoder("demo");
    expect(decode("build complete")).toEqual({ display: ["build complete"], raw: null });
    // A JSON-looking demo line is NOT decoded — it streams exactly as the demo harness printed it.
    const jsonish = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    expect(decode(jsonish)).toEqual({ display: [jsonish], raw: null });
  });
});
