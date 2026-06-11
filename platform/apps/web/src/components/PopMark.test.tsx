import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PopMark } from "./PopMark.js";

/**
 * #145 Pop Mark: the standalone vermilion dot leaping out of an ink ring (brand book). It idles with a
 * happy wiggle and, with `burst`, plays the full pop cycle on load — dot → swell → 6-ray burst → settle.
 */
describe("PopMark", () => {
  it("renders the ring and the dot", () => {
    const { container } = render(<PopMark />);
    expect(container.querySelector(".popmark")).not.toBeNull();
    expect(container.querySelector(".popmark__dot")).not.toBeNull();
  });

  it("plays the full pop cycle with a six-ray burst when burst is set", () => {
    const { container } = render(<PopMark burst />);
    expect(container.querySelector(".popmark--burst")).not.toBeNull();
    expect(container.querySelectorAll(".popmark__ray")).toHaveLength(6);
  });

  it("renders no rays when idle (the burst is an entrance, not a loop)", () => {
    const { container } = render(<PopMark />);
    expect(container.querySelectorAll(".popmark__ray")).toHaveLength(0);
  });

  it("tints to a department colour via a CSS custom property", () => {
    const { container } = render(<PopMark color="#1fa2c4" />);
    const el = container.querySelector(".popmark") as HTMLElement;
    expect(el.style.getPropertyValue("--pop-color")).toBe("#1fa2c4");
  });

  it("is decorative (hidden from assistive tech)", () => {
    const { container } = render(<PopMark />);
    expect(container.querySelector(".popmark")?.getAttribute("aria-hidden")).toBe("true");
  });
});
