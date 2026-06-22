import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { onboardingRoutes } from "../../src/routes/onboarding.js";

/**
 * Hermetic test of the #610 instant-demo single-shot feed: `GET /onboarding/deliverable`. It is the
 * non-streaming JSON sibling of the #633 SSE stream that the no-signup sandbox page fetches. PUBLIC (no
 * auth) and dependency-free (the deliverable is derived purely from the URL), so stub deps satisfy the
 * registration signature and no Postgres/onboarding service is touched.
 */

const stubService = {} as Parameters<typeof onboardingRoutes>[1]["service"];
const stubDnsManager = {} as Parameters<typeof onboardingRoutes>[1]["dnsManager"];

let app: FastifyInstance;
beforeEach(async () => {
  app = Fastify();
  await app.register(onboardingRoutes, { service: stubService, dnsManager: stubDnsManager });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("GET /onboarding/deliverable (#610 instant demo)", () => {
  it("returns a full, personalized deliverable as one JSON document, no auth required", async () => {
    const res = await app.inject({ method: "GET", url: "/onboarding/deliverable?url=acme.com" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const plan = res.json() as {
      business: { url: string; host: string; name: string };
      title: string;
      subtitle: string;
      sections: { id: string; kind: string; heading: string; body: string }[];
    };

    // Personalized to the typed URL.
    expect(plan.business.host).toBe("acme.com");
    expect(plan.business.name).toBe("Acme");
    expect(plan.title).toContain("Acme");
    expect(plan.subtitle).toContain("acme.com");

    // A real, multi-section artifact whose bodies are woven with the brand/host (theirs, not a template).
    expect(plan.sections.length).toBeGreaterThan(2);
    for (const section of plan.sections) {
      expect(section.id).toBeTruthy();
      expect(["insight", "action", "draft"]).toContain(section.kind);
      expect(section.heading).toBeTruthy();
      expect(section.body.length).toBeGreaterThan(20);
    }
    const blob = plan.sections.map((s) => s.body).join("\n");
    expect(blob).toContain("acme.com");
    expect(blob).toContain("Acme");
  });

  it("is deterministic for a given URL (same input → identical artifact)", async () => {
    const a = await app.inject({ method: "GET", url: "/onboarding/deliverable?url=https://acme.com/pricing" });
    const b = await app.inject({ method: "GET", url: "/onboarding/deliverable?url=acme.com/pricing" });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.body).toBe(b.body);
  });

  it("400s on a missing or non-web URL (never partial/faked output)", async () => {
    const missing = await app.inject({ method: "GET", url: "/onboarding/deliverable" });
    expect(missing.statusCode).toBe(400);

    const junk = await app.inject({
      method: "GET",
      url: "/onboarding/deliverable?url=javascript%3Aalert(1)",
    });
    expect(junk.statusCode).toBe(400);

    const localhost = await app.inject({ method: "GET", url: "/onboarding/deliverable?url=localhost" });
    expect(localhost.statusCode).toBe(400);
  });
});
