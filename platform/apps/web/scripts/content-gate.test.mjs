/**
 * content-gate tests (#527). Two layers:
 *   1. unit — the defect patterns from the seven open content PRs each trip the right rule, and a clean
 *      draft passes;
 *   2. regression — every committed post under content/blog/*.md passes the gate (so the gate can never be
 *      tightened past the real corpus, and the corpus can never regress past the gate).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  lintPost,
  parseAllowlist,
  significantTokens,
  isNearDuplicateSlug,
  REQUIRED_KEYS,
} from "./content-gate-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");
const BLOG_DIR = path.join(WEB_ROOT, "content", "blog");
const ALLOWLIST_FILE = path.join(WEB_ROOT, "content", "published-allowlist.txt");

const allowlist = parseAllowlist(readFileSync(ALLOWLIST_FILE, "utf8"));

/** A fully-valid draft post — the shape the gate is meant to wave through. */
const CLEAN = `---
title: A genuinely new topic about email deliverability
slug: a-genuinely-new-topic-about-email-deliverability
description: A plain-English guide to keeping startup email out of the spam folder, with the three settings that matter most.
author: quill
date: 2026-06-21
status: draft
---

# Email deliverability

Scout reads your domain records the way a mail server does. Here is what matters.
`;

const codes = (raw, extra = {}) => lintPost({ path: `content/blog/${extra.slug ?? "a-genuinely-new-topic-about-email-deliverability"}.md`, raw, publishedAllowlist: allowlist, ...extra }).violations.map((v) => v.code);

describe("content gate — clean post", () => {
  it("passes a valid draft with no markers", () => {
    const result = lintPost({ path: "content/blog/a-genuinely-new-topic-about-email-deliverability.md", raw: CLEAN, publishedAllowlist: allowlist });
    expect(result.ok, JSON.stringify(result.violations)).toBe(true);
  });

  it("allows bare agent names in prose (only @handles / channel tags are banned)", () => {
    expect(codes(CLEAN)).not.toContain("internal-marker");
  });
});

describe("content gate — defect patterns from the #527 PRs", () => {
  it("#526 / all PRs: missing required `author` key is flagged", () => {
    const raw = CLEAN.replace("author: quill\n", "");
    expect(codes(raw)).toContain("missing-frontmatter");
  });

  it("flags every missing required key", () => {
    const noFrontmatter = "# Just a body, no frontmatter\n\nHello.";
    const missing = lintPost({ path: "content/blog/x.md", raw: noFrontmatter, publishedAllowlist: allowlist })
      .violations.filter((v) => v.code === "missing-frontmatter");
    expect(missing.length).toBe(REQUIRED_KEYS.length);
  });

  it("#497/#517: an @scout handoff line in the description is an internal marker", () => {
    const raw = CLEAN.replace(
      /description: .*/,
      "description: Got the handoff from @scout — thanks. One honest flag before the polish.",
    );
    expect(codes(raw)).toContain("internal-marker");
  });

  it("#500: an A2A handoff / #content / 'drop it' chatter body is flagged", () => {
    const raw = CLEAN.replace(
      /# Email deliverability[\s\S]*$/,
      "@scout — yes, drop it. Here's the ticket, drafted in #content for a human to grab.",
    );
    const cs = codes(raw);
    expect(cs).toContain("internal-marker");
  });

  it("#524/#499: 'for human review' / channel-reasoning body is flagged", () => {
    const raw = CLEAN.replace("# Email deliverability", "Picking the keyword first, then drafting.\n\nDraft below — for human review.");
    expect(codes(raw)).toContain("internal-marker");
  });

  it("publishing a brand-new slug (not in the allowlist) is blocked", () => {
    const raw = CLEAN.replace("status: draft", "status: published");
    expect(codes(raw)).toContain("unauthorized-publish");
  });

  it("a draft never trips the publish gate", () => {
    expect(codes(CLEAN)).not.toContain("unauthorized-publish");
  });

  it("an allowlisted slug may be published", () => {
    const slug = "welcome-to-the-ipop-blog";
    const raw = CLEAN.replace(/slug: .*/, `slug: ${slug}`).replace("status: draft", "status: published");
    expect(lintPost({ path: `content/blog/${slug}.md`, raw, publishedAllowlist: allowlist }).violations.map((v) => v.code)).not.toContain("unauthorized-publish");
  });

  it("#526: a slug that does not match its filename is flagged", () => {
    const raw = CLEAN.replace(/slug: .*/, "slug: ai-marketing-agency-what-it-actually-does-and-doesn-t-in-202");
    expect(codes(raw)).toContain("slug-filename-mismatch");
  });

  it("#497: a slug near-duplicating a published post is flagged", () => {
    const slug = "the-best-ai-marketing-tools-for-startups-in-2026-and-the-one";
    const raw = CLEAN.replace(/slug: .*/, `slug: ${slug}`);
    const result = lintPost({
      path: `content/blog/${slug}.md`,
      raw,
      publishedAllowlist: allowlist,
      corpus: [{ slug: "the-best-ai-marketing-tools-for-startups-in-2026-and-how-to-actually-pick" }],
    });
    expect(result.violations.map((v) => v.code)).toContain("duplicate-topic");
  });

  it("flags SEO titles that exceed the mobile snippet limit", () => {
    const raw = CLEAN.replace(
      /title: .*/,
      "title: This startup marketing title is far too long for a search result snippet",
    );
    expect(codes(raw)).toContain("title-too-long");
  });

  it("flags descriptions outside the search-snippet bounds", () => {
    const raw = CLEAN.replace(/description: .*/, "description: Too short.");
    expect(codes(raw)).toContain("description-length");
  });

  it("flags posts with no H1 for crawler-readable article structure", () => {
    const raw = CLEAN.replace("# Email deliverability", "## Email deliverability");
    expect(codes(raw)).toContain("missing-h1");
  });
});

describe("near-duplicate detection — separates real dupes from the legit corpus", () => {
  it("flags the #497 truncated re-title as a dupe of the published tools post", () => {
    expect(
      isNearDuplicateSlug(
        "the-best-ai-marketing-tools-for-startups-in-2026-and-the-one",
        "the-best-ai-marketing-tools-for-startups-in-2026-and-how-to-actually-pick",
      ),
    ).toBe(true);
  });

  it("does NOT flag the legit 'agency' family that only shares the generic trio", () => {
    // These are three distinct committed posts; they must not collide.
    expect(isNearDuplicateSlug("what-is-an-ai-marketing-agency", "how-much-does-an-ai-marketing-agency-cost")).toBe(false);
    expect(isNearDuplicateSlug("what-is-an-ai-marketing-agency", "ai-marketing-agency-vs-hiring-an-agency")).toBe(false);
  });

  it("significantTokens drops stopwords, years, and 1-char fragments", () => {
    expect([...significantTokens("what-is-an-ai-marketing-agency-in-2026")]).toEqual(["ai", "marketing", "agency"]);
  });
});

describe("content gate — committed corpus regression guard", () => {
  const files = readdirSync(BLOG_DIR).filter((f) => f.endsWith(".md")).map((f) => path.join(BLOG_DIR, f));
  const corpus = files.map((p) => ({ slug: lintPost({ path: p, raw: readFileSync(p, "utf8"), publishedAllowlist: allowlist }).slug, path: p }));

  it("has posts to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files)("%s passes the gate", (file) => {
    const others = corpus.filter((c) => c.path !== file);
    const result = lintPost({ path: file, raw: readFileSync(file, "utf8"), corpus: others, publishedAllowlist: allowlist });
    expect(result.ok, result.violations.map((v) => `[${v.code}] ${v.message}`).join("; ")).toBe(true);
  });
});
