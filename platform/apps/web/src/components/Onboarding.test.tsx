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
  it("is one screen: one domain field, value first, and no setup homework", () => {
    render(<Onboarding />);
    expect(screen.getByLabelText(new RegExp(ONBOARDING.domainLabel, "i"))).toBeInTheDocument();
    expect(screen.queryByLabelText(/ideal customer profile/i)).not.toBeInTheDocument();
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

  it("keeps acquisition query params on the Google OAuth start URL (#901)", async () => {
    Object.defineProperty(window, "location", {
      value: {
        ...window.location,
        search: "?utm_source=linkedin&utm_medium=paid&utm_campaign=founders&ref=gref_901",
        assign: assignSpy,
      },
      writable: true,
    });
    render(<Onboarding />);
    await userEvent.type(screen.getByLabelText(new RegExp(ONBOARDING.domainLabel, "i")), "acme.com");
    await userEvent.click(screen.getByRole("button", { name: new RegExp(ONBOARDING.googleCta, "i") }));

    expect(assignSpy).toHaveBeenCalledWith(
      "/auth/google/start?domain=acme.com&utm_source=linkedin&utm_medium=paid&utm_campaign=founders&ref=gref_901",
    );
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

  it("offers email signup when Google is unavailable in this deployment", () => {
    Object.defineProperty(window, "location", {
      value: { ...window.location, search: "?error=google_unavailable", assign: assignSpy },
      writable: true,
    });
    render(<Onboarding />);

    expect(screen.getByRole("alert")).toHaveTextContent(ONBOARDING.errors.google_unavailable);
    expect(screen.getByText(ONBOARDING.fallbackSignup.lead)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ONBOARDING.fallbackSignup.cta })).toHaveAttribute(
      "href",
      "/signup",
    );
  });
});

describe("Onboarding outcome-first (#633)", () => {
  // The preview view opens a real EventSource via the default factory; jsdom has none, so stub a no-op one
  // that just constructs. We assert the *transition* into the live deliverable, not its streamed content
  // (that is covered by DeliverablePreview.test.tsx with an injected fake source).
  class NoopEventSource {
    onerror: ((ev: unknown) => void) | null = null;
    onopen: ((ev: unknown) => void) | null = null;
    addEventListener(): void {}
    close(): void {}
  }
  beforeEach(() => {
    (globalThis as unknown as { EventSource: unknown }).EventSource = NoopEventSource;
  });
  afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  });

  it("produces a deliverable immediately on submit — no setup, no redirect to config", async () => {
    render(<Onboarding />);
    await userEvent.type(screen.getByLabelText(new RegExp(ONBOARDING.domainLabel, "i")), "acme.com");
    // The PRIMARY action is the outcome, not the Google sign-in.
    await userEvent.click(screen.getByRole("button", { name: new RegExp(ONBOARDING.deliverable.cta, "i") }));
    // We did NOT navigate away to config…
    expect(assignSpy).not.toHaveBeenCalled();
    // …and the live deliverable view is now on screen, building immediately, even if the stream falls
    // back to the honest domain-only artifact.
    expect(await screen.findByRole("heading", { level: 1, name: /acme\.com starter growth brief/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /gtm workspace preview/i })).toBeInTheDocument();
    expect(screen.getByText(/Built from the domain only/i)).toBeInTheDocument();
    expect(screen.getByText(/No prospect rows yet/i)).toBeInTheDocument();
    expect(screen.getByText(/verification.blocked:no_external_sources/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(new RegExp(ONBOARDING.domainLabel, "i"))).not.toBeInTheDocument();
  });

  it("keeps Google sign-in available in parallel beside the streaming deliverable", async () => {
    render(<Onboarding />);
    await userEvent.type(screen.getByLabelText(new RegExp(ONBOARDING.domainLabel, "i")), "acme.com");
    await userEvent.click(screen.getByRole("button", { name: new RegExp(ONBOARDING.deliverable.cta, "i") }));
    // Config runs alongside: signing in from the preview still navigates to OAuth carrying the domain.
    await userEvent.click(screen.getByRole("button", { name: new RegExp(ONBOARDING.googleCta, "i") }));
    expect(assignSpy).toHaveBeenCalledWith("/auth/google/start?domain=acme.com");
  });

  it("nudges (and does not produce a deliverable) when the domain is empty", async () => {
    render(<Onboarding />);
    await userEvent.click(screen.getByRole("button", { name: new RegExp(ONBOARDING.deliverable.cta, "i") }));
    expect(screen.getByRole("alert")).toHaveTextContent(ONBOARDING.needDomain);
    expect(screen.queryByText(ONBOARDING.deliverable.working)).not.toBeInTheDocument();
  });
});
