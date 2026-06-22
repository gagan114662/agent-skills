import { describe, it, expect } from "vitest";
import {
  InMemoryContactPolicyStore,
  evaluateContact,
  filterContactable,
} from "../../src/outbound-email/suppression.js";

const NOW = 1_000_000;

describe("evaluateContact (DNC/suppression + consent — ALWAYS enforced)", () => {
  it("blocks a recipient with no consent record (consent is required)", () => {
    const store = new InMemoryContactPolicyStore();
    const d = evaluateContact(store, "stranger@example.com", { now: NOW });
    expect(d.contactable).toBe(false);
    expect(d.hasConsent).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/consent/i);
  });

  it("allows a recipient with active consent and no suppression", () => {
    const store = new InMemoryContactPolicyStore();
    store.recordConsent("Lead@Example.com", { basis: "opt_in", at: NOW - 1000 });
    const d = evaluateContact(store, "lead@example.com", { now: NOW });
    expect(d.contactable).toBe(true);
    expect(d.reasons).toEqual([]);
    expect(d.email).toBe("lead@example.com"); // normalized
  });

  it("suppression ALWAYS wins, even when consent is present", () => {
    const store = new InMemoryContactPolicyStore();
    store.recordConsent("p@example.com", { basis: "double_opt_in", at: NOW - 1000 });
    store.suppress("P@Example.com", { reason: "complaint", at: NOW });
    const d = evaluateContact(store, "p@example.com", { now: NOW });
    expect(d.contactable).toBe(false);
    expect(d.suppressed).toBe(true);
    expect(d.reasons.join(" ")).toMatch(/suppress|complaint/i);
  });

  it("treats an explicit DNC entry as a hard, permanent block", () => {
    const store = new InMemoryContactPolicyStore();
    store.recordConsent("dnc@example.com", { basis: "opt_in", at: NOW });
    store.suppress("dnc@example.com", { reason: "dnc", at: NOW });
    const d = evaluateContact(store, "dnc@example.com", { now: NOW });
    expect(d.contactable).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/dnc/i);
  });

  it("withdrawing consent both revokes consent and suppresses (opt-out)", () => {
    const store = new InMemoryContactPolicyStore();
    store.recordConsent("u@example.com", { basis: "opt_in", at: NOW - 5000 });
    expect(evaluateContact(store, "u@example.com", { now: NOW }).contactable).toBe(true);
    store.withdrawConsent("u@example.com", { at: NOW });
    const d = evaluateContact(store, "u@example.com", { now: NOW });
    expect(d.contactable).toBe(false);
    expect(d.suppressed).toBe(true);
  });

  it("expires consent older than the consent TTL", () => {
    const store = new InMemoryContactPolicyStore();
    store.recordConsent("old@example.com", { basis: "imported", at: NOW - 10_000 });
    const fresh = evaluateContact(store, "old@example.com", { now: NOW, consentTtlMs: 100_000 });
    expect(fresh.contactable).toBe(true);
    const stale = evaluateContact(store, "old@example.com", { now: NOW, consentTtlMs: 5_000 });
    expect(stale.contactable).toBe(false);
    expect(stale.reasons.join(" ")).toMatch(/expired/i);
  });
});

describe("filterContactable (batch split — suppressed/non-consented always dropped)", () => {
  it("splits a batch into contactable and blocked, de-duplicating and normalizing", () => {
    const store = new InMemoryContactPolicyStore();
    store.recordConsent("a@example.com", { basis: "opt_in", at: NOW });
    store.recordConsent("b@example.com", { basis: "opt_in", at: NOW });
    store.suppress("b@example.com", { reason: "bounce", at: NOW });
    const res = filterContactable(store, ["A@example.com", "a@example.com", "b@example.com", "c@example.com"], {
      now: NOW,
    });
    expect(res.contactable).toEqual(["a@example.com"]);
    const blockedEmails = res.blocked.map((b) => b.email).sort();
    expect(blockedEmails).toEqual(["b@example.com", "c@example.com"]);
  });

  it("never returns a suppressed address as contactable", () => {
    const store = new InMemoryContactPolicyStore();
    for (const e of ["x@example.com", "y@example.com"]) store.recordConsent(e, { basis: "opt_in", at: NOW });
    store.suppress("x@example.com", { reason: "manual", at: NOW });
    const res = filterContactable(store, ["x@example.com", "y@example.com"], { now: NOW });
    expect(res.contactable).not.toContain("x@example.com");
    expect(res.contactable).toEqual(["y@example.com"]);
  });
});
