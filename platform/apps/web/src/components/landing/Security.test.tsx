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

  it("states the customer support SLA", () => {
    render(<Security />);
    const region = screen.getByRole("region", { name: new RegExp(SECURITY.slaTitle, "i") });
    expect(within(region).getByText(SECURITY.sla)).toBeInTheDocument();
  });

  it("states the production readiness lanes for proof, policy, receipts, and setup docs (#1219)", () => {
    render(<Security />);
    const region = screen.getByRole("region", { name: new RegExp(SECURITY.readinessTitle, "i") });
    expect(within(region).getByText(SECURITY.readiness)).toBeInTheDocument();
    for (const item of SECURITY.readinessItems) {
      expect(within(region).getByText(item.title)).toBeInTheDocument();
      expect(within(region).getByText(item.body)).toBeInTheDocument();
    }
    expect(within(region).getByText(/dry-run before enabling live sends/i)).toBeInTheDocument();
    expect(within(region).getByText(/rollback path exists/i)).toBeInTheDocument();
  });

  it("keeps SOC 2, SSO, and kernel-level network policy as non-current claims (#1219)", () => {
    render(<Security />);
    const region = screen.getByRole("region", { name: new RegExp(SECURITY.roadmapTitle, "i") });
    expect(within(region).getByText(/Planned — not yet certified/i)).toBeInTheDocument();
    expect(within(region).getByText(/Designed seam — not yet built/i)).toBeInTheDocument();
    expect(within(region).getByText(/Partial — application-enforced today/i)).toBeInTheDocument();
  });

  it("offers a way back home", () => {
    render(<Security />);
    expect(screen.getAllByRole("link", { name: new RegExp(SECURITY.backCta, "i") }).length).toBeGreaterThan(0);
  });
});
