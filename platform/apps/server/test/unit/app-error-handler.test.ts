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

  it("passes client (4xx) errors through unchanged instead of masking them as a 500", async () => {
    const app = buildApp();
    app.get("/__test/bad", async () => {
      const err = new Error("missing required field: name") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    });

    const res = await app.inject({ method: "GET", url: "/__test/bad" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.message).toBe("missing required field: name");
    // A client error is not rewritten into the sanitized server-fault shape.
    expect(body.error).not.toBe("internal_error");
    await app.close();
  });
});
