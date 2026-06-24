import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { supportRoutes } from "../../src/routes/support.js";
import type { SupportDeskService } from "../../src/support/service.js";

describe("supportRoutes CSAT", () => {
  it("captures public widget CSAT from a JSON body parsed in the webhook scope", async () => {
    const submitCsat = vi.fn(async () => ({
      id: "11111111-2222-3333-4444-555555555555",
      csatScore: 5,
    }));
    const app = Fastify();
    await app.register(supportRoutes, {
      service: { submitCsat } as unknown as SupportDeskService,
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/support/widget/ws-1/tickets/11111111-2222-3333-4444-555555555555/csat",
      payload: { sourceRef: "widget-session-1", score: 5, comment: "Solved it" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ticketId: "11111111-2222-3333-4444-555555555555", csatScore: 5 });
    expect(submitCsat).toHaveBeenCalledWith(
      "ws-1",
      "11111111-2222-3333-4444-555555555555",
      "widget-session-1",
      {
        score: 5,
        comment: "Solved it",
      },
    );
    await app.close();
  });
});
