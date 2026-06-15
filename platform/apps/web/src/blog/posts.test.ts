/**
 * Blog content-store tests (#252). These load the real committed posts under `content/blog/*.md`, so they
 * also guard the seed articles (every one must be valid + published) and the frontmatter/markdown parsers.
 */
import { describe, expect, it } from "vitest";
import { listPosts, listPostMeta, getPost } from "./posts.js";
import { renderMarkdown, parseInline, plainTextExcerpt } from "./markdown.js";
import { parseFrontmatter } from "./frontmatter.js";

describe("blog content store", () => {
  it("loads the committed seed posts, all published, with required fields", () => {
    const posts = listPosts();
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const p of posts) {
      expect(p.slug, p.slug).toBeTruthy();
      expect(p.title, p.slug).toBeTruthy();
      expect(p.description, p.slug).toBeTruthy();
      expect(p.author, p.slug).toBeTruthy();
      expect(p.blocks.length, p.slug).toBeGreaterThan(0);
    }
  });

  it("sorts newest first", () => {
    const dates = listPostMeta().map((p) => p.date);
    const sorted = [...dates].sort((a, b) => (b || "").localeCompare(a || ""));
    expect(dates).toEqual(sorted);
  });

  it("has unique slugs", () => {
    const slugs = listPostMeta().map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("getPost resolves a known slug and renders its body to blocks", () => {
    const post = getPost("why-client-rendered-sites-are-invisible-to-google");
    expect(post).toBeDefined();
    expect(post!.title).toMatch(/client-rendered/i);
    // The body has a real heading block (proves markdown → typed blocks, not raw text).
    expect(post!.blocks.some((b) => b.type === "heading")).toBe(true);
  });

  it("getPost returns undefined for an unknown slug", () => {
    expect(getPost("no-such-post")).toBeUndefined();
  });

  it("credits Scout and Quill (the dogfood authors)", () => {
    const authors = new Set(listPostMeta().map((p) => p.author));
    expect(authors.has("scout")).toBe(true);
    expect(authors.has("quill")).toBe(true);
  });
});

describe("frontmatter + markdown parsers", () => {
  it("parses a frontmatter block and leaves the body", () => {
    const { meta, body } = parseFrontmatter("---\ntitle: Hi\nstatus: published\n---\n# Heading\n\nBody.");
    expect(meta.title).toBe("Hi");
    expect(meta.status).toBe("published");
    expect(body).toMatch(/^# Heading/);
  });

  it("renders headings, lists, and inline links/bold to typed blocks", () => {
    const blocks = renderMarkdown("# Title\n\nA **bold** word and a [link](https://x.dev).\n\n- one\n- two");
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
    const para = blocks.find((b) => b.type === "paragraph");
    expect(para && para.type === "paragraph" && para.inline.some((r) => r.type === "strong")).toBe(true);
    expect(para && para.type === "paragraph" && para.inline.some((r) => r.type === "link")).toBe(true);
    const list = blocks.find((b) => b.type === "list");
    expect(list && list.type === "list" && list.items).toHaveLength(2);
  });

  it("parseInline never injects raw markup (link href + text are separate fields)", () => {
    const runs = parseInline("[click](https://x.dev/a)");
    expect(runs[0]).toMatchObject({ type: "link", text: "click", href: "https://x.dev/a" });
  });

  it("plainTextExcerpt strips markdown and truncates", () => {
    const ex = plainTextExcerpt("# Heading\n\nThis is **bold** body text with a [link](https://x.dev).", 20);
    expect(ex).not.toMatch(/[#*[\]()]/);
    expect(ex.length).toBeLessThanOrEqual(21); // 20 + the ellipsis
  });
});
