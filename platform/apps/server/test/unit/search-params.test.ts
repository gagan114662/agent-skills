import { describe, it, expect } from "vitest";
import { parseSearchParams } from "../../src/routes/search-params.js";

describe("parseSearchParams (#7)", () => {
  it("requires a non-empty q", () => {
    expect(parseSearchParams({}).ok).toBe(false);
    expect(parseSearchParams({ q: "" }).ok).toBe(false);
    expect(parseSearchParams({ q: "   " }).ok).toBe(false);
    const r = parseSearchParams({});
    if (!r.ok) expect(r.error).toBe("q required");
  });

  it("trims q", () => {
    const r = parseSearchParams({ q: "  deploy  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.q).toBe("deploy");
  });

  it("defaults limit=20 offset=0", () => {
    const r = parseSearchParams({ q: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.limit).toBe(20);
      expect(r.value.offset).toBe(0);
    }
  });

  it("clamps limit to [1,100]", () => {
    const hi = parseSearchParams({ q: "x", limit: "500" });
    const lo = parseSearchParams({ q: "x", limit: "0" });
    const neg = parseSearchParams({ q: "x", limit: "-5" });
    if (hi.ok) expect(hi.value.limit).toBe(100);
    if (lo.ok) expect(lo.value.limit).toBe(1);
    if (neg.ok) expect(neg.value.limit).toBe(1);
  });

  it("falls back to defaults for non-numeric limit/offset", () => {
    const r = parseSearchParams({ q: "x", limit: "abc", offset: "xyz" });
    if (r.ok) {
      expect(r.value.limit).toBe(20);
      expect(r.value.offset).toBe(0);
    }
  });

  it("clamps negative offset to 0", () => {
    const r = parseSearchParams({ q: "x", offset: "-10" });
    if (r.ok) expect(r.value.offset).toBe(0);
  });

  it("passes through id filters", () => {
    const r = parseSearchParams({
      q: "x",
      channelId: "c1",
      authorMemberId: "m1",
      threadId: "t1",
    });
    if (r.ok) {
      expect(r.value.channelId).toBe("c1");
      expect(r.value.authorMemberId).toBe("m1");
      expect(r.value.threadId).toBe("t1");
    }
  });

  it("parses valid ISO dates and ignores invalid ones", () => {
    const r = parseSearchParams({ q: "x", after: "2026-01-01T00:00:00Z", before: "not-a-date" });
    if (r.ok) {
      expect(r.value.after?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(r.value.before).toBeUndefined();
    }
  });
});
