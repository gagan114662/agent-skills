import { describe, it, expect } from "vitest";
import {
  sanitizeLead,
  sanitizeLeadField,
  isPlausibleEmail,
  toDiscoverySignal,
  MAX_MESSAGE_CHARS,
  MAX_NAME_CHARS,
} from "../../src/leads/inbound.js";
import { createDefaultInboundLeadFollowup } from "../../src/leads/default.js";

/**
 * Pure inbound-lead helper tests (GAP 1 of the leads centre, ADR-0400). No DB, no clock, no IO — every
 * branch is exercised directly. Proves the #200 §6 injection defense (control-char strip + length cap) and
 * the conservative email-shape validation, plus the discovery-signal mapping.
 */
describe("leads/inbound: sanitizeLeadField (#200 §6)", () => {
  it("strips C0/C1 control characters and collapses whitespace", () => {
    // Build a string with a control char (0x07 BEL) without a literal in source.
    const withBell = `ab${String.fromCharCode(0x07)}cd`;
    expect(sanitizeLeadField(withBell, 100)).toBe("ab cd");
    expect(sanitizeLeadField("a\n\n\tb   c", 100)).toBe("a b c");
  });

  it("trims and hard-caps the length", () => {
    const long = "x".repeat(MAX_MESSAGE_CHARS + 50);
    expect(sanitizeLeadField(long, MAX_MESSAGE_CHARS).length).toBe(MAX_MESSAGE_CHARS);
    expect(sanitizeLeadField("   hi   ", 100)).toBe("hi");
  });
});

describe("leads/inbound: isPlausibleEmail", () => {
  it("accepts a normal address and rejects garbage", () => {
    expect(isPlausibleEmail("a@b.co")).toBe(true);
    expect(isPlausibleEmail("founder@example.com")).toBe(true);
    expect(isPlausibleEmail("nope")).toBe(false);
    expect(isPlausibleEmail("a@b")).toBe(false);
    expect(isPlausibleEmail("a @b.com")).toBe(false);
    expect(isPlausibleEmail("")).toBe(false);
  });
});

describe("leads/inbound: sanitizeLead", () => {
  it("accepts a clean lead, lower-cases the email, defaults the source", () => {
    const r = sanitizeLead({ name: "Ada", email: "Ada@Example.com", message: "fix our SEO" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead).toEqual({
      name: "Ada",
      email: "ada@example.com",
      message: "fix our SEO",
      source: "landing_form",
      trackingRef: null,
    });
  });

  it("rejects an empty email or message (rate-limit-safe minimum)", () => {
    expect(sanitizeLead({ email: "", message: "hi" })).toEqual({ ok: false, error: "email is required" });
    expect(sanitizeLead({ email: "a@b.co", message: "   " })).toEqual({
      ok: false,
      error: "message is required",
    });
  });

  it("rejects a non-email", () => {
    expect(sanitizeLead({ email: "not-an-email", message: "hi" })).toEqual({
      ok: false,
      error: "email is not a valid address",
    });
  });

  it("treats every field as untrusted: strips control chars and caps name", () => {
    const r = sanitizeLead({
      name: `${"n".repeat(MAX_NAME_CHARS + 10)}`,
      email: "a@b.co",
      message: `hello${String.fromCharCode(0x1b)}[31mworld`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.name?.length).toBe(MAX_NAME_CHARS);
    // The ESC control char is stripped to a space — no ANSI injection survives.
    expect(r.lead.message).toBe("hello [31mworld");
  });

  it("only honors an allow-listed source label and a ref-shaped trackingRef", () => {
    const r = sanitizeLead({
      email: "a@b.co",
      message: "hi",
      source: "Email Blast!!", // not [a-z0-9_] → falls back to landing_form
      trackingRef: "ipop_abc-123",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.source).toBe("landing_form");
    expect(r.lead.trackingRef).toBe("ipop_abc-123");

    const bad = sanitizeLead({ email: "a@b.co", message: "hi", trackingRef: "has space" });
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(bad.lead.trackingRef).toBeNull();
  });

  it("keeps a valid snake_case source", () => {
    const r = sanitizeLead({ email: "a@b.co", message: "hi", source: "widget_intake" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.source).toBe("widget_intake");
  });
});

describe("leads/inbound: toDiscoverySignal", () => {
  it("maps a lead to an opaque role_identified signal (no PII in the prospect key)", () => {
    const r = sanitizeLead({ name: "Ada", email: "ada@example.com", message: "hello" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sig = toDiscoverySignal(r.lead, "deadbeefhash");
    expect(sig.kind).toBe("role_identified");
    expect(sig.role).toBe("inbound_lead");
    expect(sig.prospectKey).toBe("lead_deadbeefhash");
    // The opaque key must never contain the email (discovery refuses an @-bearing key).
    expect(sig.prospectKey).not.toContain("@");
    expect(sig.detail).toMatchObject({ source: "landing_form", hasName: true });
  });
});

describe("leads/default: warm inbound follow-up", () => {
  it("imports the original lead into Reach and runs the opener/cadence batch", async () => {
    const imported: unknown[] = [];
    let batches = 0;
    const followup = createDefaultInboundLeadFollowup({
      async importProspects(_workspaceId, prospects) {
        imported.push(...prospects);
        return { imported: prospects.length, updated: 0, skipped: 0 };
      },
      async runBatch() {
        batches += 1;
        return {
          status: "completed",
          prospectsFound: 1,
          messagesSent: 1,
          messagesQueued: 0,
          suppressed: 0,
          rateLimited: 0,
          skipped: 0,
          outcomes: [],
          tuning: null,
        };
      },
    });
    await followup.handle({
      workspaceId: "ws-1",
      leadId: "lead-1",
      lead: { name: "Ada", email: "ada@acme.com", message: "Need help booking demos", source: "landing_form", trackingRef: null },
    });
    expect(imported[0]).toMatchObject({
      fullName: "Ada",
      email: "ada@acme.com",
      company: "acme",
      companyDomain: "acme.com",
      signalKind: "content_engagement",
      signalSummary: expect.stringContaining("Need help booking demos"),
    });
    expect(batches).toBe(1);
  });
});
