import { describe, it, expect } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "../../../src/site/frontmatter.js";

/**
 * #153 CMS-lite — the dependency-free frontmatter parser. Supports flat scalars and string sequences,
 * which is exactly what the marketing content store needs; nothing more, so there's no YAML dep.
 */
describe("#153 frontmatter parser", () => {
  it("parses scalars and a body, stripping quotes", () => {
    const { meta, body } = parseFrontmatter(
      ['---', 'title: "Hello there"', "slug: hello", "status: published", "---", "", "# Body", "text"].join("\n"),
    );
    expect(meta.title).toBe("Hello there");
    expect(meta.slug).toBe("hello");
    expect(meta.status).toBe("published");
    expect(body).toBe("# Body\ntext");
  });

  it("parses a string sequence under an empty key", () => {
    const { meta } = parseFrontmatter(
      ["---", "highlights:", "  - first", "  - second", "title: T", "---", "body"].join("\n"),
    );
    expect(meta.highlights).toEqual(["first", "second"]);
    expect(meta.title).toBe("T");
  });

  it("treats a document with no fence as a verbatim body", () => {
    const { meta, body } = parseFrontmatter("# Just markdown\n\nno frontmatter");
    expect(meta).toEqual({});
    expect(body).toBe("# Just markdown\n\nno frontmatter");
  });

  it("treats an unterminated fence as no frontmatter (never throws)", () => {
    const { meta, body } = parseFrontmatter("---\ntitle: oops\nno closing fence");
    expect(meta).toEqual({});
    expect(body).toContain("title: oops");
  });

  it("handles CRLF line endings", () => {
    const { meta, body } = parseFrontmatter("---\r\ntitle: T\r\n---\r\n\r\nbody\r\nmore");
    expect(meta.title).toBe("T");
    expect(body).toBe("body\nmore");
  });

  it("round-trips through serialize → parse", () => {
    const meta = { title: "Round trip", slug: "rt", tags: ["a", "b"] };
    const body = "# Heading\n\nA paragraph.";
    const out = parseFrontmatter(serializeFrontmatter(meta, body));
    expect(out.meta).toEqual(meta);
    expect(out.body).toBe(body);
  });
});
