import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Onboarding } from "./Onboarding.js";
import { api } from "../api/client.js";
import { ONBOARDING } from "../brand.js";

let assignSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom doesn't implement navigation; spy on assign so we can assert where the button sends the browser.
  assignSpy = vi.fn();
  Object.defineProperty(window, "location", {
    value: { ...window.location, search: "", assign: assignSpy },
    writable: true,
  });
  // #300: default the front-door sample-offer probe to OFF so the legacy assertions see the #260 screen.
  vi.spyOn(api, "getSampleConsole").mockResolvedValue({ offered: false, console: null });
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

  it("#300 hides the sample-workspace entry when the deployment hasn't enabled it (default OFF)", async () => {
    render(<Onboarding />);
    // Give the offer probe a tick; the link must stay absent.
    await waitFor(() => expect(api.getSampleConsole).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: new RegExp(ONBOARDING.sampleCta, "i") })).not.toBeInTheDocument();
  });

  it("#300 offers a non-Google entry (the sample workspace link) when enabled", async () => {
    vi.spyOn(api, "getSampleConsole").mockResolvedValue({
      offered: true,
      console: { readOnly: true, workspaceLabel: "Sample workspace", deliverables: [] },
    });
    render(<Onboarding />);
    const link = await screen.findByRole("link", { name: new RegExp(ONBOARDING.sampleCta, "i") });
    expect(link).toHaveAttribute("href", "/sample");
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
