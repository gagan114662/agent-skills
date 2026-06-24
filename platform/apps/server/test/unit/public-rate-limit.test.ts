import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  AUTH_PUBLIC_RATE_LIMIT,
  INBOUND_LEAD_PUBLIC_RATE_LIMIT,
  SIGNUP_PUBLIC_RATE_LIMIT,
  publicRateLimitPreHandler,
  registerPublicRateLimits,
} from "../../src/http/rate-limit.js";

describe("public conversion-surface rate limits (#936)", () => {
  it("returns 429 after the auth threshold on routes using the auth public limiter", async () => {
    const app = Fastify();
    registerPublicRateLimits(app);
    app.post(
      "/auth/login",
      { preHandler: publicRateLimitPreHandler(AUTH_PUBLIC_RATE_LIMIT) },
      async () => ({ ok: true }),
    );

    for (let i = 0; i < AUTH_PUBLIC_RATE_LIMIT.max; i += 1) {
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: {} });
      expect(res.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "POST", url: "/auth/login", payload: {} });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate limit exceeded" });
    await app.close();
  });

  it("allows a larger signup burst while still capping the public signup route", async () => {
    const app = Fastify();
    registerPublicRateLimits(app);
    app.post(
      "/auth/signup",
      { preHandler: publicRateLimitPreHandler(SIGNUP_PUBLIC_RATE_LIMIT) },
      async () => ({ ok: true }),
    );

    for (let i = 0; i < SIGNUP_PUBLIC_RATE_LIMIT.max; i += 1) {
      const res = await app.inject({ method: "POST", url: "/auth/signup", payload: {} });
      expect(res.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "POST", url: "/auth/signup", payload: {} });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });

  it("returns 429 after the inbound lead threshold on routes using the lead public limiter", async () => {
    const app = Fastify();
    registerPublicRateLimits(app);
    app.post(
      "/inbound/leads",
      { preHandler: publicRateLimitPreHandler(INBOUND_LEAD_PUBLIC_RATE_LIMIT) },
      async () => ({
        received: true,
      }),
    );

    for (let i = 0; i < INBOUND_LEAD_PUBLIC_RATE_LIMIT.max; i += 1) {
      const res = await app.inject({ method: "POST", url: "/inbound/leads", payload: {} });
      expect(res.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "POST", url: "/inbound/leads", payload: {} });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate limit exceeded" });
    await app.close();
  });
});
