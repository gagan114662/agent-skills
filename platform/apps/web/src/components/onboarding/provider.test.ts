import { describe, expect, it } from "vitest";
import { createDefaultProvider, parseTarget, OnboardingReadError } from "./provider.js";
import type { DemoDeliverableDto, FetchLike } from "../../api/demo.js";

/**
 * #784 provider seam. `parseTarget` is the pure personalization core; the default provider's `readSite` is the
 * one REAL call (the public deliverable endpoint), so we inject a fetch and assert it narrates the site's own
 * insight — and degrades to a thrown {@link OnboardingReadError} (never a faked finding) when the read fails.
 */

const plan: DemoDeliverableDto = {
  business: { url: "https://acme.com", host: "acme.com", name: "Acme" },
  title: "Acme's first-week growth teardown",
  subtitle: "A real deliverable for acme.com.",
  sections: [
    { id: "snapshot", kind: "insight", heading: "How you read", body: "Your hero buries the offer below the fold." },
    { id: "wins", kind: "action", heading: "Quick wins", body: "Ship a meta description." },
  ],
};

function okFetch(): FetchLike {
  return () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(plan) });
}

describe("parseTarget", () => {
  it("pulls a host + tidy name out of a url", () => {
    expect(parseTarget("https://www.acme.com/pricing")).toEqual({ host: "acme.com", name: "Acme" });
    expect(parseTarget("acme.io")).toEqual({ host: "acme.io", name: "Acme" });
  });

  it("treats a plain product name as the name and derives a host slug", () => {
    expect(parseTarget("Acme Invoicing")).toEqual({ host: "acmeinvoicing.com", name: "Acme Invoicing" });
  });
});

describe("createDefaultProvider (#784)", () => {
  it("readSite narrates the site's own insight from the real endpoint", async () => {
    const provider = createDefaultProvider({ fetchImpl: okFetch() });
    const finding = await provider.readSite("acme.com");
    expect(finding.host).toBe("acme.com");
    expect(finding.finding).toMatch(/buries the offer/i);
  });

  it("readSite degrades honestly (throws) when the site can't be read", async () => {
    const failFetch: FetchLike = () =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    const provider = createDefaultProvider({ fetchImpl: failFetch });
    await expect(provider.readSite("acme.com")).rejects.toBeInstanceOf(OnboardingReadError);
  });

  it("connect produces a real, tool-shaped payoff personalized from the target", async () => {
    const provider = createDefaultProvider({ fetchImpl: okFetch() });
    const gmail = await provider.connect("gmail", "acme.com");
    const social = await provider.connect("social", "acme.com");
    const site = await provider.connect("site", "acme.com");
    expect(gmail.tool).toBe("gmail");
    expect(social.tool === "social" && social.threads).toHaveLength(3);
    expect(site.tool === "site" && site.after).toMatch(/Acme/);
  });

  it("ship records the ship and the deliverable never silently spends money", async () => {
    const provider = createDefaultProvider({ fetchImpl: okFetch() });
    const deliverable = await provider.buildDeliverable("acme.com");
    expect(deliverable.spendsMoney).toBe(false);
    expect(await provider.ship()).toEqual({ shipped: true });
  });
});
