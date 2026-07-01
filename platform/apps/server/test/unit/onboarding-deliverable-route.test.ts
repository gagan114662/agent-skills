import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { onboardingRoutes } from "../../src/routes/onboarding.js";
import type { SiteSnapshot } from "../../src/onboarding/deliverable.js";

/**
 * Hermetic test of the #633 outcome-first SSE contract. The route is PUBLIC (no auth) and depends on
 * neither Postgres nor the onboarding service. It injects a fake public-site reader so no live network is
 * touched. Pacing is disabled so `inject` collects the full stream.
 */

const stubService = {} as Parameters<typeof onboardingRoutes>[1]["service"];
const stubDnsManager = {} as Parameters<typeof onboardingRoutes>[1]["dnsManager"];
let snapshot: SiteSnapshot | null;

let app: FastifyInstance;
beforeEach(async () => {
  process.env.ONBOARDING_DELIVERABLE_STREAM_DELAY_MS = "0";
  snapshot = {
    sourceUrl: "https://acme.com/",
    status: 200,
    title: "Acme Scheduling — book more demos",
    description: "Acme helps B2B teams qualify leads and book better demo calls.",
    h1: "Book better demo calls",
    ctas: ["Book a demo", "Start free"],
    keywords: ["demo", "calls", "leads"],
  };
  app = Fastify();
  await app.register(onboardingRoutes, {
    service: stubService,
    dnsManager: stubDnsManager,
    deliverableSiteReader: async () => snapshot,
  });
  await app.ready();
});

afterEach(async () => {
  delete process.env.ONBOARDING_DELIVERABLE_STREAM_DELAY_MS;
  await app.close();
});

describe("GET /onboarding/deliverable/stream (#633)", () => {
  it("streams a personalized deliverable over SSE: start → sections → done, no auth required", async () => {
    const res = await app.inject({ method: "GET", url: "/onboarding/deliverable/stream?url=acme.com" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const body = res.body;
    expect(body).toContain("event: start");
    expect(body).toContain("event: section");
    expect(body).toContain("event: done");
    // Personalized to the typed URL.
    expect(body).toContain("acme.com");
    expect(body).toContain("Acme");
    expect(body).toContain("Book better demo calls");
    expect(body).toContain("Book a demo");
    // Header arrives before the first section, which arrives before done.
    expect(body.indexOf("event: start")).toBeLessThan(body.indexOf("event: section"));
    expect(body.indexOf("event: section")).toBeLessThan(body.indexOf("event: done"));
  });

  it("400s on a missing or non-web URL without streaming", async () => {
    const missing = await app.inject({ method: "GET", url: "/onboarding/deliverable/stream" });
    expect(missing.statusCode).toBe(400);
    const junk = await app.inject({
      method: "GET",
      url: "/onboarding/deliverable/stream?url=javascript%3Aalert(1)",
    });
    expect(junk.statusCode).toBe(400);
  });

  it("502s without opening an SSE stream when the homepage cannot be read", async () => {
    snapshot = null;
    const res = await app.inject({ method: "GET", url: "/onboarding/deliverable/stream?url=acme.com" });
    expect(res.statusCode).toBe(502);
    expect(res.headers["content-type"]).toContain("application/json");
  });
});
