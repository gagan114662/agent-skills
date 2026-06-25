import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONTACT, SUPPORT_CONTACT } from "../../brand.js";
import { ContactForm } from "./ContactForm.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function submit(): Promise<void> {
  await userEvent.type(screen.getByLabelText(CONTACT.emailLabel), "ada@example.com");
  await userEvent.type(screen.getByLabelText(CONTACT.messageLabel), "We want to improve our SEO.");
  await userEvent.click(screen.getByRole("checkbox", { name: /public legal terms/i }));
  await userEvent.click(screen.getByRole("button", { name: CONTACT.submitLabel }));
}

describe("ContactForm failure visibility (#938)", () => {
  it("offers booking and free-trial CTAs beside the lead form (#899)", () => {
    render(<ContactForm />);

    expect(screen.getByRole("link", { name: CONTACT.bookingCta })).toHaveAttribute(
      "href",
      CONTACT.bookingHref,
    );
    expect(screen.getByRole("link", { name: CONTACT.trialCta })).toHaveAttribute(
      "href",
      CONTACT.trialHref,
    );
  });

  it("posts the hidden honeypot field empty for human submissions (#929)", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({}), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetch);

    render(<ContactForm />);
    await submit();

    expect(fetch).toHaveBeenCalled();
    const [, init] = fetch.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      email: "ada@example.com",
      companyWebsite: "",
      termsAccepted: true,
      legalConsentVersion: "public-legal-dpa-2026-06-25",
    });
    expect(typeof body.legalConsentAt).toBe("string");
  });

  it("requires consent and links the public legal pages (#863)", () => {
    render(<ContactForm />);

    const consent = screen.getByRole("checkbox", { name: /public legal terms/i });
    expect(consent).toHaveAttribute("required");
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "DPA" })).toHaveAttribute("href", "/dpa");
    expect(screen.getByText(/data-subject-rights requests/i)).toBeInTheDocument();
  });

  it("posts the real UTM source and tracking ref from the landing URL (#901)", async () => {
    Object.defineProperty(window, "location", {
      value: { ...window.location, search: "?utm_source=producthunt&utm_medium=launch&ref=trk_901" },
      writable: true,
    });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({}), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetch);

    render(<ContactForm />);
    await submit();

    const [, init] = fetch.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ source: "producthunt", trackingRef: "trk_901" });
  });

  it("logs non-2xx captures and shows the accessible error alert", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "bad" }), { status: 400 })),
    );

    render(<ContactForm />);
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(CONTACT.errorNote);
    expect(screen.getByRole("alert")).toHaveTextContent(SUPPORT_CONTACT.email);
    expect(error).toHaveBeenCalledWith("Inbound lead capture failed", { status: 400 });
  });

  it("logs network failures and shows the same alert", async () => {
    const err = new Error("network down");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw err;
      }),
    );

    render(<ContactForm />);
    await submit();

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(CONTACT.errorNote));
    expect(error).toHaveBeenCalledWith("Inbound lead capture request failed", err);
  });

  it("styles the error state distinctly from body text and success text", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const rule = css.match(/\.contact-form__error\s*\{[^}]+\}/)?.[0] ?? "";

    expect(rule).toContain("color: var(--vermilion)");
    expect(rule).toContain("font-weight: 700");
    expect(rule).toContain("border-left: 3px solid var(--vermilion)");
    expect(rule).toContain("background:");
  });
});
