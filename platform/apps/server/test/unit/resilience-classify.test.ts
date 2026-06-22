import { describe, it, expect } from "vitest";
import { classifyFailure, parseRetryAfterMs } from "../../src/resilience/classify.js";

describe("parseRetryAfterMs", () => {
  it("parses numeric seconds into ms", () => {
    expect(parseRetryAfterMs("120", null)).toBe(120_000);
    expect(parseRetryAfterMs("0", null)).toBe(0);
  });

  it("returns null for an absent or blank header", () => {
    expect(parseRetryAfterMs(null, 1_000)).toBeNull();
    expect(parseRetryAfterMs("   ", 1_000)).toBeNull();
  });

  it("parses an HTTP-date relative to now", () => {
    const now = Date.parse("Wed, 21 Oct 2025 07:28:00 GMT");
    expect(parseRetryAfterMs("Wed, 21 Oct 2025 07:28:30 GMT", now)).toBe(30_000);
  });

  it("clamps a past HTTP-date to 0 (never negative)", () => {
    const now = Date.parse("Wed, 21 Oct 2025 07:28:00 GMT");
    expect(parseRetryAfterMs("Wed, 21 Oct 2025 07:27:00 GMT", now)).toBe(0);
  });

  it("cannot resolve a date form without a clock", () => {
    expect(parseRetryAfterMs("Wed, 21 Oct 2025 07:28:00 GMT", null)).toBeNull();
  });
});

describe("classifyFailure — HTTP statuses", () => {
  it("429 is a transient rate_limit and extracts Retry-After", () => {
    const c = classifyFailure({ status: 429, headers: { "retry-after": "5" } });
    expect(c).toMatchObject({ transient: true, kind: "rate_limit", status: 429, retryAfterMs: 5_000 });
  });

  it("5xx is a transient server error", () => {
    expect(classifyFailure({ status: 503 })).toMatchObject({ transient: true, kind: "server", status: 503 });
    expect(classifyFailure({ statusCode: 500 })).toMatchObject({ transient: true, kind: "server" });
  });

  it("408/425 are transient timeouts", () => {
    expect(classifyFailure({ status: 408 }).kind).toBe("timeout");
    expect(classifyFailure({ status: 425 }).transient).toBe(true);
  });

  it("other 4xx are permanent (not retried)", () => {
    expect(classifyFailure({ status: 400 })).toMatchObject({ transient: false, kind: "permanent" });
    expect(classifyFailure({ status: 401 }).transient).toBe(false);
    expect(classifyFailure({ status: 404 }).transient).toBe(false);
  });

  it("reads status + headers nested under response (axios-style)", () => {
    const c = classifyFailure({ response: { status: 429, headers: { "Retry-After": "2" } } });
    expect(c).toMatchObject({ kind: "rate_limit", status: 429, retryAfterMs: 2_000 });
  });

  it("reads from a Headers-like object with a .get()", () => {
    const headers = { get: (n: string) => (n.toLowerCase() === "retry-after" ? "7" : null) };
    expect(classifyFailure({ status: 429, headers }).retryAfterMs).toBe(7_000);
  });
});

describe("classifyFailure — network codes", () => {
  it.each(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE"])("%s is transient network", (code) => {
    expect(classifyFailure({ code })).toMatchObject({ transient: true, kind: "network", status: null });
  });

  it("a permanent DNS miss (ENOTFOUND) is NOT retried", () => {
    expect(classifyFailure({ code: "ENOTFOUND" })).toMatchObject({ transient: false, kind: "permanent" });
  });

  it("an unrecognised error is permanent", () => {
    expect(classifyFailure(new Error("boom"))).toMatchObject({ transient: false, kind: "permanent" });
    expect(classifyFailure(null)).toMatchObject({ transient: false, kind: "permanent" });
  });
});
