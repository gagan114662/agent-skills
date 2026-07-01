import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CompanyPage } from "./CompanyPage.js";

describe("CompanyPage", () => {
  it("renders procurement basics and public review links (#1188)", () => {
    render(<CompanyPage />);

    expect(screen.getByRole("heading", { name: /company information/i })).toBeInTheDocument();
    expect(screen.getByText(/Gagan Arora, owner\/operator of ipop\.ai/i)).toBeInTheDocument();
    expect(screen.getByText(/buyer packet/i)).toBeInTheDocument();
    expect(screen.getByText(/security questionnaire/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /login/i })).toHaveAttribute("href", "/login?return=%2Feveryday");
    expect(screen.getByRole("link", { name: /dashboard/i })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: /start/i })).toHaveAttribute("href", "https://t.me/ipopmarketingbot");
    expect(screen.queryByRole("link", { name: /back home/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "DPA" })).toHaveAttribute("href", "/dpa");
    expect(screen.getByRole("link", { name: "Email support" })).toHaveAttribute("href", "mailto:support@ipop.ai");
  });
});
