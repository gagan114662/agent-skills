import { describe, it, expect } from "vitest";
import {
  SUPPRESSION_REASONS,
  normalizeRecipient,
  isSuppressed,
  filterSuppressed,
  reasonFromWebhook,
  buildComplianceFooter,
  appendComplianceFooter,
  hasComplianceFooter,
  isFooterInfoComplete,
  checkEmailCompliance,
  warmupCapForDay,
  warmupAllows,
  WARMUP_SCHEDULE_PER_DAY,
  type FooterInfo,
} from "../../src/acquisition/compliance.js";

const footer: FooterInfo = {
  brandName: "Acme",
  postalAddress: "123 Main St, Springfield",
  unsubscribeUrl: "https://acme.test/unsub",
};

describe("suppression list", () => {
  it("normalizes recipients (trim + lowercase) so suppression over-matches", () => {
    expect(normalizeRecipient("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });

  it("matches case-insensitively", () => {
    const set = new Set(["foo@bar.com"]);
    expect(isSuppressed("FOO@BAR.com", set)).toBe(true);
    expect(isSuppressed("other@bar.com", set)).toBe(false);
  });

  it("splits, normalizes, and de-duplicates recipients", () => {
    const set = new Set(["blocked@x.com"]);
    const { allowed, suppressed } = filterSuppressed(
      ["A@x.com", "a@x.com", "Blocked@x.com", "ok@x.com", ""],
      set,
    );
    expect(allowed).toEqual(["a@x.com", "ok@x.com"]);
    expect(suppressed).toEqual(["blocked@x.com"]);
  });

  it("maps ESP webhook events to suppression reasons", () => {
    expect(reasonFromWebhook("Bounce")).toBe("bounce");
    expect(reasonFromWebhook("HardBounce")).toBe("bounce");
    expect(reasonFromWebhook("dropped")).toBe("bounce");
    expect(reasonFromWebhook("SpamComplaint")).toBe("complaint");
    expect(reasonFromWebhook("spamreport")).toBe("complaint");
    expect(reasonFromWebhook("Unsubscribe")).toBe("unsubscribe");
    expect(reasonFromWebhook("Delivered")).toBeNull();
    expect(reasonFromWebhook("Open")).toBeNull();
  });

  it("every mapped reason is a known reason", () => {
    for (const e of ["Bounce", "SpamComplaint", "unsubscribe"]) {
      const r = reasonFromWebhook(e);
      expect(r && SUPPRESSION_REASONS).toContain(r);
    }
  });
});

describe("CAN-SPAM / GDPR footer", () => {
  it("includes brand, postal address, unsubscribe, and a GDPR line", () => {
    const f = buildComplianceFooter(footer);
    expect(f).toContain("Acme");
    expect(f).toContain("123 Main St");
    expect(f).toContain("https://acme.test/unsub");
    expect(f.toLowerCase()).toContain("gdpr");
  });

  it("appends idempotently", () => {
    const once = appendComplianceFooter("Hello", footer);
    const twice = appendComplianceFooter(once, footer);
    expect(hasComplianceFooter(once)).toBe(true);
    expect(twice).toBe(once);
  });

  it("validates footer completeness", () => {
    expect(isFooterInfoComplete(footer)).toBe(true);
    expect(isFooterInfoComplete(undefined)).toBe(false);
    expect(isFooterInfoComplete({ brandName: "Acme", postalAddress: "", unsubscribeUrl: "x" })).toBe(
      false,
    );
  });
});

describe("checkEmailCompliance", () => {
  const suppressed = new Set(["bad@x.com"]);

  it("passes a footered email to deliverable recipients", () => {
    const body = appendComplianceFooter("Hi", footer);
    const r = checkEmailCompliance({
      body,
      recipients: ["good@x.com", "bad@x.com"],
      suppressed,
      footerInfo: footer,
    });
    expect(r.ok).toBe(true);
    expect(r.allowedRecipients).toEqual(["good@x.com"]);
    expect(r.suppressedRecipients).toEqual(["bad@x.com"]);
    expect(r.violations.some((v) => v.includes("suppressed"))).toBe(true);
  });

  it("fails when the body has no compliance footer", () => {
    const r = checkEmailCompliance({
      body: "no footer here",
      recipients: ["good@x.com"],
      suppressed,
      footerInfo: footer,
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes("footer"))).toBe(true);
  });

  it("fails when footer info is incomplete", () => {
    const body = appendComplianceFooter("Hi", footer);
    const r = checkEmailCompliance({
      body,
      recipients: ["good@x.com"],
      suppressed,
      footerInfo: { brandName: "Acme" },
    });
    expect(r.ok).toBe(false);
  });

  it("fails when every recipient is suppressed (no deliverable remainder)", () => {
    const body = appendComplianceFooter("Hi", footer);
    const r = checkEmailCompliance({
      body,
      recipients: ["bad@x.com"],
      suppressed,
      footerInfo: footer,
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes("no deliverable"))).toBe(true);
  });
});

describe("domain warmup", () => {
  it("ramps the per-day cap and goes uncapped once warm", () => {
    expect(warmupCapForDay(0)).toBe(WARMUP_SCHEDULE_PER_DAY[0]);
    expect(warmupCapForDay(0)).toBeLessThan(warmupCapForDay(1));
    expect(warmupCapForDay(WARMUP_SCHEDULE_PER_DAY.length)).toBe(Number.POSITIVE_INFINITY);
    expect(warmupCapForDay(-1)).toBe(0);
  });

  it("grants up to the remaining headroom under the day's cap", () => {
    const d = warmupAllows(0, 40, 30); // cap 50, 40 sent → 10 headroom
    expect(d.capForDay).toBe(50);
    expect(d.grantable).toBe(10);
    expect(d.allowed).toBe(true);
  });

  it("grants the full batch when it fits", () => {
    const d = warmupAllows(1, 0, 50); // cap 100
    expect(d.grantable).toBe(50);
    expect(d.allowed).toBe(true);
  });

  it("grants everything once the domain is warm", () => {
    const d = warmupAllows(99, 1_000_000, 999);
    expect(d.allowed).toBe(true);
    expect(d.grantable).toBe(999);
  });

  it("disallows when no headroom remains", () => {
    const d = warmupAllows(0, 50, 10);
    expect(d.allowed).toBe(false);
    expect(d.grantable).toBe(0);
  });
});
