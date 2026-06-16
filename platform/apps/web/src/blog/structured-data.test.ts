/**
 * JSON-LD structured-data builder tests (#294): the schema.org graph injected into the prerendered head so
 * crawlers get the explicit ipop entity / blog / article instead of inferring it from prose.
 */
import { describe, expect, it } from "vitest";
import {
  organizationLd,
  websiteLd,
  breadcrumbLd,
  blogLd,
  blogPostingLd,
  renderJsonLd,
} from "./structured-data.js";
import type { BlogPostMeta } from "./posts.js";

const ORIGIN = "https://ipop.ai";
const POST: BlogPostMeta = {
  slug: "what-is-an-ai-marketing-agency",
  title: "What is an AI marketing agency?",
  description: "A founder's guide.",
  author: "scout",
  date: "2026-06-16",
  readingTime: "6 min read",
};

describe("organizationLd / websiteLd", () => {
  it("emit a stable ipop Organization and WebSite rooted at the origin", () => {
    const org = organizationLd(ORIGIN);
    expect(org["@type"]).toBe("Organization");
    expect(org.name).toBe("ipop");
    expect(org.url).toBe("https://ipop.ai/");
    const site = websiteLd(ORIGIN);
    expect(site["@type"]).toBe("WebSite");
    expect(site.url).toBe("https://ipop.ai/");
    // No SearchAction: we don't serve site-search, so we must not claim one.
    expect(JSON.stringify(site)).not.toContain("SearchAction");
  });
});

describe("breadcrumbLd", () => {
  it("numbers positions from 1 and resolves absolute item URLs", () => {
    const bc = breadcrumbLd(ORIGIN, [
      ["ipop", "/"],
      ["The ipop blog", "/blog"],
      [POST.title, `/blog/${POST.slug}`],
    ]);
    const items = bc.itemListElement as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ position: 1, name: "ipop", item: "https://ipop.ai/" });
    expect(items[2]).toMatchObject({
      position: 3,
      item: "https://ipop.ai/blog/what-is-an-ai-marketing-agency",
    });
  });
});

describe("blogLd", () => {
  it("lists each post as a BlogPosting head with an absolute URL", () => {
    const blog = blogLd(ORIGIN, [POST]);
    expect(blog["@type"]).toBe("Blog");
    const posts = blog.blogPost as Array<Record<string, unknown>>;
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      "@type": "BlogPosting",
      headline: POST.title,
      url: "https://ipop.ai/blog/what-is-an-ai-marketing-agency",
      datePublished: "2026-06-16",
    });
  });
});

describe("blogPostingLd", () => {
  it("builds an article node with author, publisher, image, and self-referential mainEntityOfPage", () => {
    const node = blogPostingLd(ORIGIN, POST);
    expect(node).toMatchObject({
      "@type": "BlogPosting",
      headline: POST.title,
      url: "https://ipop.ai/blog/what-is-an-ai-marketing-agency",
      datePublished: "2026-06-16",
      dateModified: "2026-06-16",
    });
    expect((node.author as Record<string, unknown>).name).toBe("scout");
    expect((node.publisher as Record<string, unknown>)["@type"]).toBe("Organization");
    expect((node.mainEntityOfPage as Record<string, unknown>)["@id"]).toBe(
      "https://ipop.ai/blog/what-is-an-ai-marketing-agency",
    );
  });

  it("omits dates when the post has none", () => {
    const node = blogPostingLd(ORIGIN, { ...POST, date: "" });
    expect(node).not.toHaveProperty("datePublished");
  });
});

describe("renderJsonLd", () => {
  it("wraps a single node in a ld+json script and stays valid JSON", () => {
    const html = renderJsonLd(organizationLd(ORIGIN));
    expect(html).toMatch(/^<script type="application\/ld\+json">/);
    expect(html).toMatch(/<\/script>$/);
    const json = html.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    // Unicode-escapes round-trip back to valid parseable JSON.
    expect(JSON.parse(json)["@type"]).toBe("Organization");
  });

  it("serializes an array of nodes as a JSON array", () => {
    const html = renderJsonLd([organizationLd(ORIGIN), websiteLd(ORIGIN)]);
    const json = html.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it("escapes </script> and other angle brackets so a value can't break out of the element", () => {
    const malicious = blogPostingLd(ORIGIN, {
      ...POST,
      title: 'Pwn</script><script>alert(1)</script>',
    });
    const html = renderJsonLd(malicious);
    // The raw closing tag must not appear except as the single genuine terminator.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("\\u003c");
    // Still parses (unescape happens at JSON.parse time).
    const json = html.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    expect(JSON.parse(json).headline).toContain("alert(1)");
  });
});
