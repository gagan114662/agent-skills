import { describe, it, expect } from "vitest";
import { parsePrTitle, parsePrLine, draftChangelog } from "../../../src/site/changelog.js";

/**
 * #153 changelog drafter — "echo summarises merged PRs → owner approves → publish". Pure: PR titles in,
 * release-notes markdown out, grouped New / Fixed / Improved in the house voice.
 */
describe("#153 PR title parser", () => {
  it("parses type, scope, and summary", () => {
    expect(parsePrTitle("feat(#153): the marketing-site machine")).toEqual({
      type: "feat",
      scope: "#153",
      breaking: false,
      summary: "the marketing-site machine",
    });
  });

  it("flags breaking changes", () => {
    expect(parsePrTitle("feat!: drop the old API").breaking).toBe(true);
  });

  it("falls back to `other` for non-conventional titles", () => {
    expect(parsePrTitle("Random title")).toEqual({ type: "other", breaking: false, summary: "Random title" });
  });
});

describe("#153 PR list line parser (gh output → MergedPr)", () => {
  it("pulls a trailing (#123) into the number", () => {
    expect(parsePrLine("feat(#1): a thing (#161)")).toEqual({ title: "feat(#1): a thing", number: 161 });
  });
  it("pulls a leading #123 into the number", () => {
    expect(parsePrLine("#162 fix: a bug")).toEqual({ title: "fix: a bug", number: 162 });
  });
  it("keeps a bare title and skips blank lines", () => {
    expect(parsePrLine("just a title")).toEqual({ title: "just a title" });
    expect(parsePrLine("   ")).toBeNull();
  });
});

describe("#153 changelog draft", () => {
  const prs = [
    { title: "feat(#153): marketing-site machine", number: 161 },
    { title: "feat(web): pricing page", number: 128 },
    { title: "fix(api): handle empty changelog", number: 162 },
    { title: "docs: update README", number: 163 },
    { title: "chore: bump deps", number: 164 },
  ];

  it("groups by New / Fixed / Improved and credits Echo", () => {
    const draft = draftChangelog(prs, "2026-06-08");
    expect(draft.agent).toBe("echo");
    expect(draft.slug).toBe("2026-06-08");
    expect(draft.title).toBe("Week of 2026-06-08");
    expect(draft.body).toContain("### New");
    expect(draft.body).toContain("### Fixed");
    expect(draft.body).toContain("### Improved");
    // Feature lines land under New with their PR ref.
    expect(draft.body).toMatch(/### New[\s\S]*Marketing-site machine \(#161\)/);
    // docs + chore roll up into Improved.
    expect(draft.body).toMatch(/### Improved[\s\S]*Update README \(#163\)/);
    expect(draft.summary).toContain("5 changes shipped");
  });

  it("produces a valid quiet entry for an empty week", () => {
    const draft = draftChangelog([], "2026-06-15");
    expect(draft.summary).toContain("quiet week");
    expect(draft.body.length).toBeGreaterThan(0);
  });

  it("marks breaking changes in the body", () => {
    const draft = draftChangelog([{ title: "feat!: new gate", number: 1 }], "2026-06-08");
    expect(draft.body).toContain("**Breaking:**");
  });
});
