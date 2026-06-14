import { describe, it, expect } from "vitest";
import {
  namingPrecheck,
  normalizeName,
  stubNamingAvailabilityChecker,
} from "../../src/venture-factory/naming.js";

describe("normalizeName", () => {
  it("lowercases, collapses non-alphanumerics to single hyphens, trims edges", () => {
    expect(normalizeName("  Acme Widgets!! ")).toBe("acme-widgets");
    expect(normalizeName("Foo___Bar")).toBe("foo-bar");
    expect(normalizeName("--Lead--")).toBe("lead");
  });
});

describe("namingPrecheck (deterministic, no network)", () => {
  it("passes a clean name and lists the irreversible domain/trademark steps", () => {
    const r = namingPrecheck("Acme Widgets");
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe("acme-widgets");
    expect(r.reasons).toEqual([]);
    expect(r.irreversibleSteps.map((s) => s.kind)).toEqual(["domain_register", "trademark_file"]);
  });

  it("is deterministic — same input, same verdict", () => {
    expect(namingPrecheck("Acme Widgets")).toEqual(namingPrecheck("Acme Widgets"));
  });

  it("rejects a too-short name and lists no irreversible steps", () => {
    const r = namingPrecheck("a");
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/too short/);
    expect(r.irreversibleSteps).toEqual([]);
  });

  it("rejects a too-long name", () => {
    expect(namingPrecheck("a".repeat(41)).ok).toBe(false);
  });

  it("rejects a reserved word", () => {
    const r = namingPrecheck("Admin");
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/reserved/);
  });

  it("rejects a blocklisted brand-unsafe term", () => {
    const r = namingPrecheck("BestScamEver");
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/blocklisted/);
  });
});

describe("stubNamingAvailabilityChecker (never auto-registers)", () => {
  it("returns null availability (unknown) — parks domain/trademark for a human", async () => {
    const a = await stubNamingAvailabilityChecker.check("acme-widgets");
    expect(a.domainAvailable).toBeNull();
    expect(a.trademarkClear).toBeNull();
    expect(a.reason).toMatch(/not checked/);
  });
});
