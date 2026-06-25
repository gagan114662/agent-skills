import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CompanyPage } from "./CompanyPage.js";

describe("CompanyPage", () => {
  it("renders procurement basics and public review links (#1188)", () => {
    render(<CompanyPage />);

    expect(screen.getByRole("heading", { name: /company information/i })).toBeInTheDocument();
    expect(screen.getByText(/public contracting entity name is not yet published/i)).toBeInTheDocument();
    expect(screen.getByText(/buyer packet/i)).toBeInTheDocument();
    expect(screen.getByText(/security questionnaire/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "DPA" })).toHaveAttribute("href", "/dpa");
    expect(screen.getByRole("link", { name: "Email support" })).toHaveAttribute("href", "mailto:support@ipop.ai");
  });
});
