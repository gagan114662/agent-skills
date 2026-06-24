import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPublicRateLimits } from "../../src/http/rate-limit.js";
import { inboundLeadsRoutes } from "../../src/routes/inbound-leads.js";
import type { DiscoveryService } from "../../src/discovery/service.js";

describe("inbound lead public route hardening (#936)", () => {
  it("silently accepts honeypot-filled submissions without touching discovery", async () => {
    const app = Fastify();
    registerPublicRateLimits(app);
    let discoveryCalls = 0;
    app.register(inboundLeadsRoutes, {
      ownerWorkspaceId: "00000000-0000-0000-0000-000000000001",
      discovery: {
        defineSignal: async () => {
          discoveryCalls += 1;
          throw new Error("honeypot should not reach discovery");
        },
        ingestSignal: async () => {
          discoveryCalls += 1;
        },
      } as unknown as DiscoveryService,
    });

    const res = await app.inject({
      method: "POST",
      url: "/inbound/leads",
      payload: {
        email: "bot@example.com",
        message: "I am totally a prospect",
        companyWebsite: "https://spam.example",
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ received: true });
    expect(discoveryCalls).toBe(0);
    await app.close();
  });
});
