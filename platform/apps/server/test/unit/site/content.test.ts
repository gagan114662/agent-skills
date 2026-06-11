import { describe, it, expect } from "vitest";
import {
  loadSection,
  loadDoc,
  toDoc,
  isSiteSection,
  SITE_SECTIONS,
  type ContentSource,
} from "../../../src/site/content.js";

/** A tiny in-memory content source for the loader tests (the disk source has its own integration). */
function memSource(files: Record<string, Record<string, string>>): ContentSource {
  return {
    async list(section) {
      return Object.entries(files[section] ?? {}).map(([slug, raw]) => ({ slug, raw }));
    },
    async read(section, slug) {
      return files[section]?.[slug];
    },
  };
}

const published = (title: string, extra = "") =>
  `---\ntitle: ${title}\nstatus: published\nagent: quill\n${extra}---\n\nBody of ${title}.`;
const draft = (title: string) => `---\ntitle: ${title}\nstatus: draft\n---\n\nDraft body.`;

describe("#153 content loader", () => {
  it("knows its four sections", () => {
    expect([...SITE_SECTIONS]).toEqual(["compare", "stories", "guides", "changelog"]);
    expect(isSiteSection("compare")).toBe(true);
    expect(isSiteSection("nope")).toBe(false);
  });

  it("defaults a missing status to draft (invisible) — fail safe", () => {
    const doc = toDoc("guides", "x", "---\ntitle: X\n---\nbody");
    expect(doc.status).toBe("draft");
    expect(doc.agent).toBe("quill"); // default author credit
  });

  it("lists only published docs, never drafts", async () => {
    const source = memSource({
      compare: { "vs-diy": published("DIY"), secret: draft("Secret") },
    });
    const list = await loadSection(source, "compare");
    expect(list.map((d) => d.slug)).toEqual(["vs-diy"]);
    expect(list[0]).not.toHaveProperty("body"); // list view is metadata-only
  });

  it("loads a published doc with body but hides a draft", async () => {
    const source = memSource({
      stories: { live: published("Live"), wip: draft("WIP") },
    });
    const live = await loadDoc(source, "stories", "live");
    expect(live?.title).toBe("Live");
    expect(live?.body).toContain("Body of Live.");
    expect(await loadDoc(source, "stories", "wip")).toBeUndefined();
    expect(await loadDoc(source, "stories", "missing")).toBeUndefined();
  });

  it("orders by explicit `order` first, then newest date", async () => {
    const source = memSource({
      guides: {
        a: published("A", "order: 2\ndate: 2026-01-01\n"),
        b: published("B", "order: 1\ndate: 2025-01-01\n"),
        c: published("C", "date: 2026-06-01\n"),
      },
    });
    const list = await loadSection(source, "guides");
    // ordered (1,2) come before unordered; unordered fall back to date desc.
    expect(list.map((d) => d.slug)).toEqual(["b", "a", "c"]);
  });
});
