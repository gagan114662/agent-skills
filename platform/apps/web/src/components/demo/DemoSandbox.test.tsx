import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ACQUISITION_EVENT_TARGET } from "../../acquisition-events.js";
import { DemoSandbox } from "./DemoSandbox.js";
import type { DemoDeliverableDto, FetchLike } from "../../api/demo.js";

/**
 * #610 instant-demo sandbox. The fetch is injected and the reveal cadence forced to 0 (instant) so the
 * whole no-signup flow — type a URL → personalized artifact → signup CTA — renders synchronously under
 * jsdom, plus the honest-degrade path when the build fails.
 */

const plan: DemoDeliverableDto = {
  business: { url: "https://acme.com", host: "acme.com", name: "Acme" },
  title: "Acme's first-week growth teardown",
  subtitle: "A real deliverable for acme.com — built before you set anything up.",
  sections: [
    {
      id: "snapshot",
      kind: "insight",
      heading: "How a first-time visitor sees you",
      body: "We read acme.com…",
    },
    {
      id: "quick-wins",
      kind: "action",
      heading: "Three quick wins",
      body: "1. Ship a meta description…",
    },
    {
      id: "headline",
      kind: "draft",
      heading: "A homepage headline",
      body: "Headline: Acme — the fastest…",
    },
  ],
};

function okFetch(): { impl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const impl: FetchLike = (input) => {
    calls.push(input);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(plan) });
  };
  return { impl, calls };
}

afterEach(() => vi.restoreAllMocks());

describe("DemoSandbox (#610)", () => {
  it("opens on the no-signup entry form, not an artifact", () => {
    const { impl } = okFetch();
    render(<DemoSandbox fetchImpl={impl} revealDelayMs={0} />);
    expect(screen.getByLabelText(/your website/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /build my free deliverable/i })).toBeInTheDocument();
    // No fetch until the visitor asks.
    expect(screen.queryByText(plan.sections[0]!.heading)).not.toBeInTheDocument();
  });

  it("keeps the shared public action nav on the standalone demo page", () => {
    const { impl } = okFetch();
    render(<DemoSandbox fetchImpl={impl} revealDelayMs={0} />);
    const nav = screen.getByRole("navigation", { name: "homepage actions" });
    expect(within(nav).getByRole("link", { name: "Login" })).toHaveAttribute(
      "href",
      "/login?return=%2Feveryday",
    );
    expect(within(nav).getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(within(nav).getByRole("link", { name: "Start" })).toHaveAttribute(
      "href",
      "/start#onboard-target",
    );
    const footer = screen.getByRole("navigation", { name: "Public footer" });
    expect(within(footer).getByRole("link", { name: "Demo" })).toHaveAttribute("href", "/demo");
    expect(within(footer).getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/pricing");
    expect(within(footer).getByRole("link", { name: "Company" })).toHaveAttribute("href", "/company");
  });

  it("builds a personalized deliverable from the typed URL and surfaces the signup CTA", async () => {
    const { impl, calls } = okFetch();
    const events: string[] = [];
    window.addEventListener(ACQUISITION_EVENT_TARGET, (event) => {
      events.push((event as CustomEvent<{ event: string }>).detail.event);
    });
    render(<DemoSandbox fetchImpl={impl} revealDelayMs={0} />);

    fireEvent.change(screen.getByLabelText(/your website/i), { target: { value: "acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: /build my free deliverable/i }));

    // Every section of the real artifact renders, woven with the brand.
    for (const section of plan.sections) {
      await waitFor(() => expect(screen.getByText(section.heading)).toBeInTheDocument());
    }
    expect(calls).toEqual(["/onboarding/deliverable?url=acme.com"]);

    // The conversion close: personalized to the host, with a zero-card signup link that preserves context.
    expect(screen.getByText(/want this working on acme\.com for real/i)).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /start free/i });
    expect(cta).toHaveAttribute(
      "href",
      "/signup?source=demo&demoHost=acme.com&demoUrl=https%3A%2F%2Facme.com",
    );
    fireEvent.click(cta);
    expect(window.sessionStorage.getItem("ipop-demo-intent")).toContain("acme.com");
    expect(events).toEqual(["demo-start", "demo-complete", "demo-to-signup"]);
  });

  it("submits the actual typed website instead of falling back to the canned example", async () => {
    const calls: string[] = [];
    const tomoPlan: DemoDeliverableDto = {
      ...plan,
      business: { url: "https://tomo.ai", host: "tomo.ai", name: "Tomo" },
      title: "Tomo's first-week growth teardown",
      subtitle: "A real deliverable for tomo.ai — built before you set anything up.",
    };
    const impl: FetchLike = (input) => {
      calls.push(input);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(tomoPlan) });
    };
    render(<DemoSandbox fetchImpl={impl} revealDelayMs={0} />);

    const form = screen.getByRole("button", { name: /build my free deliverable/i }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.change(screen.getByLabelText(/your website/i), { target: { value: "tomo.ai" } });
    fireEvent.submit(form!);

    await waitFor(() => expect(screen.getByText("Tomo's first-week growth teardown")).toBeInTheDocument());
    expect(calls).toEqual(["/onboarding/deliverable?url=tomo.ai"]);
  });

  it("refuses to fetch an empty URL and shows an inline error", () => {
    const { impl, calls } = okFetch();
    render(<DemoSandbox fetchImpl={impl} revealDelayMs={0} />);
    fireEvent.click(screen.getByRole("button", { name: /build my free deliverable/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/enter your website/i);
    expect(calls).toEqual([]);
  });

  it("degrades honestly to an error and returns to the form when the build fails", async () => {
    const impl: FetchLike = () =>
      Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({}) });
    render(<DemoSandbox fetchImpl={impl} revealDelayMs={0} />);

    fireEvent.change(screen.getByLabelText(/your website/i), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: /build my free deliverable/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    // Still on the entry form (no faked artifact), so the visitor can correct and retry.
    expect(screen.getByLabelText(/your website/i)).toBeInTheDocument();
    expect(screen.queryByText(plan.sections[0]!.heading)).not.toBeInTheDocument();
  });
});
