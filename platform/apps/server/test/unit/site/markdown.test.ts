import { describe, it, expect } from "vitest";
import { renderMarkdown, parseInline } from "../../../src/site/markdown.js";

/**
 * #153 markdown → typed blocks. The renderer never emits HTML (returns a discriminated union the React
 * component maps to elements), so agent-authored content can't inject markup. These tests pin the
 * subset cornerstone SEO content uses.
 */
describe("#153 inline parser", () => {
  it("parses bold and links, keeping surrounding text", () => {
    expect(parseInline("a **bold** and a [link](https://x.io) end")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", text: "bold" },
      { type: "text", text: " and a " },
      { type: "link", text: "link", href: "https://x.io" },
      { type: "text", text: " end" },
    ]);
  });

  it("returns plain text when there are no runs", () => {
    expect(parseInline("just words")).toEqual([{ type: "text", text: "just words" }]);
  });
});

describe("#153 block renderer", () => {
  it("renders headings at levels 1-3", () => {
    const blocks = renderMarkdown("# One\n## Two\n### Three");
    expect(blocks.map((b) => b.type === "heading" && b.level)).toEqual([1, 2, 3]);
  });

  it("joins consecutive lines into one paragraph and splits on blank lines", () => {
    const blocks = renderMarkdown("line one\nline two\n\nsecond para");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "paragraph" });
    expect((blocks[0] as { inline: { text: string }[] }).inline[0].text).toBe("line one line two");
  });

  it("groups unordered and ordered list items", () => {
    const blocks = renderMarkdown("- a\n- b\n\n1. first\n2. second");
    expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ type: "list", ordered: true });
  });

  it("renders blockquotes and fenced code", () => {
    const blocks = renderMarkdown("> wise words\n> more\n\n```\ncode line\n```");
    expect(blocks[0]).toMatchObject({ type: "quote" });
    expect(blocks[1]).toEqual({ type: "code", text: "code line" });
  });

  it("keeps inline runs inside list items", () => {
    const blocks = renderMarkdown("- see [docs](https://x.io)");
    const items = (blocks[0] as { items: { type: string }[][] }).items;
    expect(items[0].some((i) => i.type === "link")).toBe(true);
  });

  it("parses a markdown table into header + rows", () => {
    const blocks = renderMarkdown("| Feature | DIY | ipop |\n|---|---|---|\n| Speed | Slow | Fast |\n| Cost | Time | Plan |");
    expect(blocks).toHaveLength(1);
    const table = blocks[0] as { type: string; header: unknown[]; rows: unknown[][] };
    expect(table.type).toBe("table");
    expect(table.header).toHaveLength(3);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toHaveLength(3);
  });
});
