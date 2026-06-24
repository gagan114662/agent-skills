import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";

describe("global error handler", () => {
  it("sanitizes arbitrary uncaught errors and returns a correlation id", async () => {
    const app = buildApp();
    app.get("/__test/boom", async () => {
      throw new Error("secret sql failure at /srv/app/internal.ts password=do-not-leak");
    });

    const res = await app.inject({ method: "GET", url: "/__test/boom" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toEqual({ error: "internal_error", requestId: expect.any(String) });
    expect(res.headers["x-request-id"]).toBe(body.requestId);
    expect(res.payload).not.toContain("do-not-leak");
    expect(res.payload).not.toContain("internal.ts");
    expect(res.payload).not.toContain("stack");
    await app.close();
  });
});
