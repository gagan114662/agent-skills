import { describe, expect, it } from "vitest";
import {
  createDefaultProvider,
  parseTarget,
  OnboardingConnectUnavailableError,
  OnboardingReadError,
} from "./provider.js";
import type { OnboardingConnectionsClient } from "./provider.js";
import type { DemoDeliverableDto, FetchLike } from "../../api/demo.js";
import type { ConnectionView, ConnectionsResponse } from "../../api/types.js";

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

function connection(over: Partial<ConnectionView>): ConnectionView {
  return {
    id: "email",
    label: "Connect email",
    summary: "Let your fleet send email on your behalf.",
    provider: "email",
    kind: "esp",
    audience: "customer",
    auth: "one_click",
    status: "available",
    capabilities: ["send_email"],
    oauthScopes: [],
    connected: false,
    ...over,
  };
}

function response(connections: ConnectionView[]): ConnectionsResponse {
  return { connections, canManageInternal: false };
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

  it("one-click connects email and immediately returns a visible draft payoff (#1070)", async () => {
    const client: OnboardingConnectionsClient = {
      getConnections: () => Promise.resolve(response([connection({ connected: false })])),
      enableConnection: (id) =>
        Promise.resolve(response([connection({ id, connected: true })])),
    };
    const provider = createDefaultProvider({ fetchImpl: okFetch(), connections: client });

    await expect(provider.connect("gmail", "acme.com")).resolves.toMatchObject({
      tool: "gmail",
      lead: { subject: "re: Acme" },
      draft: expect.stringMatching(/nothing sends until you approve/i),
    });
  });

  it("connect refuses to fake OAuth-backed payoffs that are still coming soon", async () => {
    const client: OnboardingConnectionsClient = {
      getConnections: () =>
        Promise.resolve(
          response([
            connection({
              id: "social_aggregator",
              label: "Connect your social accounts",
              provider: "social_aggregator",
              kind: "ad_account",
              auth: "oauth",
              status: "coming_soon",
              capabilities: ["post_social"],
            }),
            connection({
              id: "website",
              label: "Connect your website",
              provider: "website",
              kind: "hosting",
              auth: "oauth",
              status: "coming_soon",
              capabilities: ["site_publish"],
            }),
          ]),
        ),
      enableConnection: () => Promise.resolve(response([])),
    };
    const provider = createDefaultProvider({ fetchImpl: okFetch(), connections: client });
    await expect(provider.connect("social", "acme.com")).rejects.toMatchObject({
      message: expect.stringMatching(/still coming soon/i),
    });
    await expect(provider.connect("site", "acme.com")).rejects.toMatchObject({
      message: expect.stringMatching(/still coming soon/i),
    });
    await expect(provider.connect("social", "acme.com")).rejects.toBeInstanceOf(
      OnboardingConnectUnavailableError,
    );
  });

  it("ship records the ship and the deliverable never silently spends money", async () => {
    const provider = createDefaultProvider({ fetchImpl: okFetch() });
    const deliverable = await provider.buildDeliverable("acme.com");
    expect(deliverable.spendsMoney).toBe(false);
    expect(await provider.ship()).toEqual({ shipped: true });
  });
});
