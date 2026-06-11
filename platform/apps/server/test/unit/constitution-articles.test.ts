import { describe, it, expect } from "vitest";
import { ARTICLES, articleById } from "../../src/constitution/articles.js";

describe("ARTICLES (the constitution as data)", () => {
  it("holds all eight Articles with unique roman-numeral ids", () => {
    const ids = ARTICLES.map((a) => a.id);
    expect(ids).toEqual(["I", "II", "III", "IV", "V", "VI", "VII", "VIII"]);
    expect(new Set(ids).size).toBe(8);
  });

  it("gives every Article a title, principle, YC source, and enforcement note", () => {
    for (const a of ARTICLES) {
      expect(a.title.length).toBeGreaterThan(0);
      expect(a.principle.length).toBeGreaterThan(0);
      expect(a.source.length).toBeGreaterThan(0);
      expect(a.enforcedBy.length).toBeGreaterThan(0);
    }
  });

  it("looks up an Article by id", () => {
    expect(articleById("I")?.title).toMatch(/want/i);
    expect(articleById("VIII")?.title).toMatch(/pric|charge/i);
  });
});
