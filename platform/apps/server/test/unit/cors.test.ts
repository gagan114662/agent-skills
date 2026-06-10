import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerCors, parseEnvOrigins } from "../../src/http/cors.js";

async function appWith(allowedOrigins: string[]): Promise<FastifyInstance> {
  const app = Fastify();
  registerCors(app, { allowedOrigins });
  app.get("/me", async () => ({ ok: true }));
  app.post("/auth/login", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("registerCors (#108 split deployment)", () => {
  it("reflects an allow-listed origin with credentials + Vary", async () => {
    const app = await appWith(["https://ipop.ai", "https://www.ipop.ai"]);
    const res = await app.inject({ method: "GET", url: "/me", headers: { origin: "https://ipop.ai" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://ipop.ai");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["vary"]).toContain("Origin");
    await app.close();
  });

  it("does NOT echo CORS headers for an origin off the allowlist", async () => {
    const app = await appWith(["https://ipop.ai"]);
    const res = await app.inject({ method: "GET", url: "/me", headers: { origin: "https://evil.example" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("answers a credentialed preflight with 204 + method/header allowances", async () => {
    const app = await appWith(["https://ipop.ai"]);
    const res = await app.inject({
      method: "OPTIONS",
      url: "/auth/login",
      headers: {
        origin: "https://ipop.ai",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://ipop.ai");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]).toContain("content-type");
    await app.close();
  });

  it("is a no-op when no origins are configured (same-origin behavior preserved)", async () => {
    const app = await appWith([]);
    const res = await app.inject({ method: "GET", url: "/me", headers: { origin: "https://ipop.ai" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("parseEnvOrigins splits, trims, and drops blanks", () => {
    expect(parseEnvOrigins({ RELOAD_WEB_ORIGIN: " https://ipop.ai , https://www.ipop.ai ," })).toEqual([
      "https://ipop.ai",
      "https://www.ipop.ai",
    ]);
    expect(parseEnvOrigins({})).toEqual([]);
  });
});
