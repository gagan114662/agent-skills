import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Landing } from "./Landing.js";
import { navigate } from "../../routing.js";
import { BRAND, FLEET, LANDING, WORKSPACE, STORY, FAQ, BILLING } from "../../brand.js";

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => navigate("/")); // reset the route between click tests
  document.documentElement.lang = "en";
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
    expect(screen.getByText(/made by robots, steered by humans/i)).toBeInTheDocument();
  });

  it("routes the two hero calls-to-action to /start and /login", () => {
    render(<Landing />);
    const hero = screen.getByRole("region", { name: BRAND.tagline });
    // #260: "Get started" now leads to the one-screen Google onboarding (/start), not the email form.
    expect(
      within(hero).getByRole("link", { name: new RegExp(LANDING.hero.ctaPrimary, "i") }),
    ).toHaveAttribute("href", "/start");
    expect(
      within(hero).getByRole("link", { name: new RegExp(LANDING.hero.ctaSecondary, "i") }),
    ).toHaveAttribute("href", "/login");
  });

  it("actually navigates to /start when the hero 'Start free' CTA is clicked (#305)", async () => {
    act(() => navigate("/")); // start on the landing, as a visitor would
    render(<Landing />);
    const hero = screen.getByRole("region", { name: BRAND.tagline });
    const cta = within(hero).getByRole("link", {
      name: new RegExp(LANDING.hero.ctaPrimary, "i"),
    });

    expect(window.location.pathname).toBe("/");
    await userEvent.click(cta);
    // A plain left-click must client-navigate to the sign-in entry — not a no-op that stays on `/`.
    expect(window.location.pathname).toBe("/start");
  });

  it("renders the full workspace simulation: the complete sidebar and the active channel", () => {
    render(<Landing />);
    const sim = screen.getByRole("img", { name: /inside the .* workspace/i });
    // Every department channel from the sidebar data is present in the rendered sidebar (scoped to the
    // sidebar — the active channel name also appears in the channel header).
    const sidebar = within(sim).getByRole("complementary", { name: /workspace channels/i });
    const depts = WORKSPACE.sidebar.find((s) => s.title === "Departments")!;
    for (const ch of depts.items) {
      expect(within(sidebar).getByText(ch.name)).toBeInTheDocument();
    }
    // The pinned rooms and the ⌘K search affordance show too.
    expect(within(sidebar).getByText("#launch")).toBeInTheDocument();
    expect(within(sidebar).getByText(WORKSPACE.searchHint)).toBeInTheDocument();
  });

  it("plays the whole day-arc: every timeline entry is present in the DOM", () => {
    render(<Landing />);
    const sim = screen.getByRole("img", { name: /inside the .* workspace/i });
    for (const entry of WORKSPACE.timeline) {
      if (entry.kind === "message") {
        expect(within(sim).getByText(entry.text)).toBeInTheDocument();
      } else if (entry.kind === "task") {
        expect(within(sim).getByText(entry.id)).toBeInTheDocument();
        expect(within(sim).getByText(entry.title)).toBeInTheDocument();
      } else if (entry.kind === "approval") {
        expect(within(sim).getByText(entry.title)).toBeInTheDocument();
        expect(within(sim).getByText(entry.reply)).toBeInTheDocument(); // the human's "ship it"
      }
    }
  });

  it("reveals every timeline entry immediately when reduced motion is preferred", () => {
    stubReducedMotion(true);
    render(<Landing />);
    const sim = screen.getByRole("img", { name: /inside the .* workspace/i });
    const shown = sim.querySelectorAll(".sim-entry.is-shown");
    expect(shown.length).toBe(WORKSPACE.timeline.length);
  });

  it("tells the four numbered story sections, each with its product-true visual", () => {
    render(<Landing />);
    for (const story of STORY) {
      expect(screen.getByText(story.title)).toBeInTheDocument();
    }
    // Story visuals render real app slices: mission control, the approvals drawer, the decision log.
    expect(screen.getByLabelText(/mission control/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^approvals$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/decision log/i)).toBeInTheDocument();
  });

  it("introduces every member of the department with its personality", () => {
    render(<Landing />);
    const dept = screen.getByRole("region", { name: /meet the department/i });
    for (const agent of FLEET) {
      expect(within(dept).getByText(agent.name)).toBeInTheDocument();
      expect(within(dept).getByText(agent.personality)).toBeInTheDocument();
    }
  });

  it("renders pricing as the in-app billing screen with the current plan marked", () => {
    render(<Landing />);
    const pricing = screen.getByRole("region", { name: /pick your pop/i });
    for (const plan of LANDING.plans) {
      expect(within(pricing).getByText(plan.name)).toBeInTheDocument();
    }
    // The billing chrome marks one plan as the current subscription.
    expect(within(pricing).getAllByText(BILLING.currentLabel).length).toBeGreaterThan(0);
    // "See all plans" sends a price-shopping visitor to the dedicated pricing page (#214), not signup.
    expect(
      within(pricing).getByRole("link", { name: new RegExp(LANDING.sections.pricingCta, "i") }),
    ).toHaveAttribute("href", "/pricing");
  });

  it("answers the FAQ with every question present", () => {
    render(<Landing />);
    const faq = screen.getByRole("region", { name: new RegExp(FAQ.title, "i") });
    for (const item of FAQ.items) {
      expect(within(faq).getByText(item.q)).toBeInTheDocument();
    }
  });

  it("exposes sticky in-page anchor nav linking to the page's sections", () => {
    render(<Landing />);
    const nav = screen.getAllByRole("navigation", { name: /on this page/i }).find((el) =>
      el.classList.contains("landing__nav-links"),
    )!;
    for (const anchor of LANDING.anchors) {
      expect(
        within(nav).getByRole("link", { name: anchor.label }),
      ).toHaveAttribute("href", anchor.href);
    }
  });

  it("does not render dead placeholder social links in the footer (#941)", () => {
    render(<Landing />);
    expect(screen.queryByRole("navigation", { name: LANDING.footer.socialTitle })).toBeNull();
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href") ?? "").not.toMatch(/^\/social\//);
    }
  });

  it("keeps in-page section navigation reachable through the mobile menu", () => {
    render(<Landing />);
    const mobileNav = screen.getAllByRole("navigation", { name: /on this page/i })[0]!;
    for (const anchor of LANDING.anchors) {
      expect(within(mobileNav).getByRole("link", { name: anchor.label })).toHaveAttribute("href", anchor.href);
    }
  });

  it("renders the French landing copy when ?lang=fr is present", () => {
    act(() => navigate("/?lang=fr"));
    render(<Landing />);
    expect(screen.getByText("Une equipe marketing IA complete")).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: /sur cette page/i })).toHaveLength(2);
    expect(document.documentElement.lang).toBe("fr");
  });
});
