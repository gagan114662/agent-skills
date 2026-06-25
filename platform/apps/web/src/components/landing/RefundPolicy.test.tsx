import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { REFUND_POLICY } from "../../brand.js";
import { RefundPolicy } from "./RefundPolicy.js";

describe("RefundPolicy (#865)", () => {
  it("publishes refund terms and the support SLA", () => {
    render(<RefundPolicy />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(REFUND_POLICY.title);
    expect(screen.getByText(REFUND_POLICY.sub)).toBeInTheDocument();
    const terms = screen.getByRole("region", { name: REFUND_POLICY.navLabel });
    for (const section of REFUND_POLICY.sections) {
      expect(within(terms).getByText(section.title)).toBeInTheDocument();
      expect(within(terms).getByText(section.body)).toBeInTheDocument();
    }
  });

  it("links back to pricing and security", () => {
    render(<RefundPolicy />);
    expect(screen.getAllByRole("link", { name: REFUND_POLICY.cta })[0]).toHaveAttribute(
      "href",
      REFUND_POLICY.ctaHref,
    );
    expect(screen.getByRole("link", { name: REFUND_POLICY.securityCta })).toHaveAttribute(
      "href",
      REFUND_POLICY.securityHref,
    );
  });
});
