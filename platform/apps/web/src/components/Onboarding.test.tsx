import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Onboarding } from "./Onboarding.js";
import { ONBOARDING } from "../brand.js";

let assignSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom doesn't implement navigation; spy on assign so we can assert where the button sends the browser.
  assignSpy = vi.fn();
  Object.defineProperty(window, "location", {
    value: { ...window.location, search: "", assign: assignSpy },
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Onboarding screen (#260)", () => {
  it("is one screen: a domain field + Sign in with Google, and no password/workspace fields", () => {
    render(<Onboarding />);
    expect(screen.getByLabelText(new RegExp(ONBOARDING.domainLabel, "i"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(ONBOARDING.googleCta, "i") })).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^workspace$/i)).not.toBeInTheDocument();
  });

  it("sends the browser to the Google OAuth start URL carrying the typed domain", async () => {
    render(<Onboarding />);
    await userEvent.type(screen.getByLabelText(new RegExp(ONBOARDING.domainLabel, "i")), "acme.com");
    await userEvent.click(screen.getByRole("button", { name: new RegExp(ONBOARDING.googleCta, "i") }));
    expect(assignSpy).toHaveBeenCalledWith("/auth/google/start?domain=acme.com");
  });

  it("nudges (and does not navigate) when the domain is empty", async () => {
    render(<Onboarding />);
    await userEvent.click(screen.getByRole("button", { name: new RegExp(ONBOARDING.googleCta, "i") }));
    expect(assignSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(ONBOARDING.needDomain);
  });

  it("renders the friendly message for a redirected-back ?error=<code>", () => {
    Object.defineProperty(window, "location", {
      value: { ...window.location, search: "?error=invalid_domain", assign: assignSpy },
      writable: true,
    });
    render(<Onboarding />);
    expect(screen.getByRole("alert")).toHaveTextContent(ONBOARDING.errors.invalid_domain);
  });
});
