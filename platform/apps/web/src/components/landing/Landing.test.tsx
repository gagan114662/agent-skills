import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Landing } from "./Landing.js";
import { BRAND, FLEET, LANDING } from "../../brand.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** jsdom has no matchMedia; stub one that reports the given reduced-motion preference. */
function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduced && query.includes("reduce"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  );
}

describe("Landing", () => {
  it("leads with the brand promise and the sign-off voice", () => {
    render(<Landing />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(BRAND.tagline);
    // The sign-off appears in the footer.
    expect(screen.getByText(/made by robots, steered by humans/i)).toBeInTheDocument();
  });

  it("routes the two hero calls-to-action to /signup and /login", () => {
    render(<Landing />);
    // Scope to the hero — the nav repeats the same affordances elsewhere on the page.
    const hero = screen.getByRole("region", { name: BRAND.tagline });
    expect(
      within(hero).getByRole("link", { name: new RegExp(LANDING.hero.ctaPrimary, "i") }),
    ).toHaveAttribute("href", "/signup");
    expect(
      within(hero).getByRole("link", { name: new RegExp(LANDING.hero.ctaSecondary, "i") }),
    ).toHaveAttribute("href", "/login");
  });

  it("introduces every member of the department with its personality", () => {
    render(<Landing />);
    const dept = screen.getByRole("region", { name: /meet the department/i });
    for (const agent of FLEET) {
      expect(within(dept).getByText(agent.name)).toBeInTheDocument();
      expect(within(dept).getByText(agent.personality)).toBeInTheDocument();
    }
  });

  it("explains the flow in three steps and teases the three plans", () => {
    render(<Landing />);
    for (const step of LANDING.steps) {
      expect(screen.getByText(step.title)).toBeInTheDocument();
    }
    const pricing = screen.getByRole("region", { name: /pick your pop/i });
    for (const plan of LANDING.plans) {
      expect(within(pricing).getByText(plan.name)).toBeInTheDocument();
      expect(within(pricing).getByText(plan.price)).toBeInTheDocument();
    }
  });

  it("renders the staged hero vignette with all of its scripted lines present", () => {
    render(<Landing />);
    const vignette = screen.getByRole("region", { name: /fleet at work/i });
    for (const line of LANDING.vignette) {
      expect(within(vignette).getByText(line.text)).toBeInTheDocument();
    }
  });

  it("shows every vignette line immediately when reduced motion is preferred", () => {
    stubReducedMotion(true);
    render(<Landing />);
    const vignette = screen.getByRole("region", { name: /fleet at work/i });
    // Reduced-motion: the whole script is shown at once (the `is-shown` reveal class on each line).
    const shown = vignette.querySelectorAll(".vignette__line.is-shown");
    expect(shown.length).toBe(LANDING.vignette.length);
  });
});
