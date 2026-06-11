import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Security } from "./Security.js";
import { SECURITY } from "../../brand.js";

describe("Security trust page (#151)", () => {
  it("renders the real, shipped guarantees", () => {
    render(<Security />);
    const region = screen.getByRole("region", { name: new RegExp(SECURITY.guaranteesTitle, "i") });
    for (const g of SECURITY.guarantees) {
      expect(within(region).getByText(g.title)).toBeInTheDocument();
    }
  });

  it("frames the roadmap items as not-yet, with an explicit status each", () => {
    render(<Security />);
    const region = screen.getByRole("region", { name: new RegExp(SECURITY.roadmapTitle, "i") });
    for (const r of SECURITY.roadmap) {
      expect(within(region).getByText(r.title)).toBeInTheDocument();
      expect(within(region).getByText(r.status)).toBeInTheDocument();
    }
  });

  it("states the honest no-certifications disclaimer", () => {
    render(<Security />);
    const region = screen.getByRole("region", { name: new RegExp(SECURITY.notClaimedTitle, "i") });
    expect(within(region).getByText(SECURITY.notClaimed)).toBeInTheDocument();
  });

  it("offers a way back home", () => {
    render(<Security />);
    expect(screen.getAllByRole("link", { name: new RegExp(SECURITY.backCta, "i") }).length).toBeGreaterThan(0);
  });
});
