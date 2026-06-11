import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Wordmark } from "./Wordmark.js";
import { BRAND } from "../brand.js";

/**
 * #138 pop identity — the wordmark renders the brand name with a "popped" i-dot (the brand heartbeat).
 * It reads the name from BRAND (no hardcoded brand string) so a rebrand flows through, and exposes an
 * accessible label so screen readers still hear the plain name.
 */
describe("Wordmark", () => {
  it("renders the brand name and labels it accessibly", () => {
    render(<Wordmark />);
    expect(screen.getByLabelText(BRAND.name)).toBeInTheDocument();
  });

  it("pops the dot on the first 'i' (the popped i-dot)", () => {
    const { container } = render(<Wordmark />);
    // BRAND.name is "ipop" → exactly one popped i-dot element.
    expect(container.querySelector(".wordmark__dot")).not.toBeNull();
  });

  it("renders the rest of the name beside the popped i", () => {
    // The popped "i" renders as a dotless stem (the dot is the separate animated element), so the raw
    // glyph text isn't literally the name — the accessible name (asserted above) carries "ipop". The
    // remaining letters must still render.
    const { container } = render(<Wordmark />);
    expect(container.textContent).toContain("pop");
  });
});
