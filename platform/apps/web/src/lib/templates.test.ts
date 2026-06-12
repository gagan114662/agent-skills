import { describe, expect, it } from "vitest";
import { unresolvedPlaceholders, hasUnresolvedPlaceholders, fillTemplate } from "./templates.js";

describe("template variables (#167)", () => {
  it("finds the distinct placeholders in a body", () => {
    expect(unresolvedPlaceholders("Audit {{site}} for {{site}} and {{topic}}")).toEqual(["site", "topic"]);
    expect(unresolvedPlaceholders("no vars here")).toEqual([]);
  });

  it("hasUnresolvedPlaceholders is stable across repeated calls (no global-regex statefulness)", () => {
    const text = "Run an SEO audit of {{site}}.";
    expect(hasUnresolvedPlaceholders(text)).toBe(true);
    expect(hasUnresolvedPlaceholders(text)).toBe(true); // would flip to false if lastIndex leaked
    expect(hasUnresolvedPlaceholders("all filled in")).toBe(false);
  });

  it("substitutes filled values and leaves blanks/missing as the literal token", () => {
    const body = "Audit {{site}} on the {{topic}} theme.";
    expect(fillTemplate(body, { site: "ipop.ai", topic: "launch" })).toBe("Audit ipop.ai on the launch theme.");
    // A blank value must NOT resolve — the send guard relies on the token surviving.
    expect(fillTemplate(body, { site: "ipop.ai", topic: "   " })).toBe("Audit ipop.ai on the {{topic}} theme.");
    expect(hasUnresolvedPlaceholders(fillTemplate(body, { site: "ipop.ai" }))).toBe(true);
  });
});
