import { describe, it, expect } from "vitest";
import {
  assessSenderAuth,
  parseAuthenticationResults,
  confirmDeliverability,
} from "../../src/email/deliverability.js";

describe("assessSenderAuth (config-side SPF/DKIM/DMARC alignment)", () => {
  it("is aligned only when all three mechanisms are published + verified", () => {
    const a = assessSenderAuth({
      spf: { published: true, includesEsp: true },
      dkim: { published: true, verified: true },
      dmarc: { published: true, policy: "quarantine" },
    });
    expect(a.spf).toBe("pass");
    expect(a.dkim).toBe("pass");
    expect(a.dmarc).toBe("pass");
    expect(a.aligned).toBe(true);
    expect(a.reasons).toEqual([]);
  });

  it("fails SPF when published but the ESP host is not included", () => {
    const a = assessSenderAuth({
      spf: { published: true, includesEsp: false },
      dkim: { published: true, verified: true },
      dmarc: { published: true, policy: "none" },
    });
    expect(a.spf).toBe("fail");
    expect(a.aligned).toBe(false);
    expect(a.reasons.some((r) => /spf/i.test(r))).toBe(true);
  });

  it("treats a missing mechanism as unknown (never assumes pass) and is not aligned", () => {
    const a = assessSenderAuth({ spf: undefined, dkim: undefined, dmarc: undefined });
    expect(a.spf).toBe("unknown");
    expect(a.dkim).toBe("unknown");
    expect(a.dmarc).toBe("unknown");
    expect(a.aligned).toBe(false);
  });

  it("fails DKIM when published but not yet verified by the ESP", () => {
    const a = assessSenderAuth({
      spf: { published: true, includesEsp: true },
      dkim: { published: true, verified: false },
      dmarc: { published: true, policy: "none" },
    });
    expect(a.dkim).toBe("fail");
    expect(a.aligned).toBe(false);
  });
});

describe("parseAuthenticationResults (production message-header receipt)", () => {
  it("reads spf/dkim/dmarc pass from a real Authentication-Results header", () => {
    const r = parseAuthenticationResults(
      "mx.google.com; spf=pass smtp.mailfrom=ipop.ai; dkim=pass header.d=ipop.ai; dmarc=pass (p=NONE)",
    );
    expect(r.spf).toBe("pass");
    expect(r.dkim).toBe("pass");
    expect(r.dmarc).toBe("pass");
  });

  it("reads a fail and is case-insensitive", () => {
    const r = parseAuthenticationResults("x; SPF=FAIL; DKIM=pass; DMARC=fail");
    expect(r.spf).toBe("fail");
    expect(r.dkim).toBe("pass");
    expect(r.dmarc).toBe("fail");
  });

  it("returns unknown for a mechanism absent from the header (never assumes)", () => {
    const r = parseAuthenticationResults("x; dkim=pass");
    expect(r.spf).toBe("unknown");
    expect(r.dkim).toBe("pass");
    expect(r.dmarc).toBe("unknown");
  });

  it("returns all-unknown for a missing/empty header", () => {
    const r = parseAuthenticationResults(null);
    expect(r).toEqual({ spf: "unknown", dkim: "unknown", dmarc: "unknown" });
  });
});

describe("confirmDeliverability (#200 §3 — verification must touch reality)", () => {
  const aligned = {
    spf: { published: true, includesEsp: true },
    dkim: { published: true, verified: true },
    dmarc: { published: true, policy: "quarantine" as const },
  };

  it("is NOT deliverable on config alignment alone — a real delivered-message header is required", () => {
    const c = confirmDeliverability({ auth: aligned });
    expect(c.config.aligned).toBe(true);
    expect(c.headers).toBeNull();
    expect(c.deliverable).toBe(false);
    expect(c.reasons.some((r) => /header|unverified|receipt/i.test(r))).toBe(true);
  });

  it("is deliverable only when config is aligned AND the delivered header passes all three", () => {
    const c = confirmDeliverability({
      auth: aligned,
      authResultsHeader: "x; spf=pass; dkim=pass; dmarc=pass",
    });
    expect(c.deliverable).toBe(true);
    expect(c.reasons).toEqual([]);
  });

  it("is NOT deliverable when the delivered header shows a failure even if config looks aligned", () => {
    const c = confirmDeliverability({
      auth: aligned,
      authResultsHeader: "x; spf=pass; dkim=fail; dmarc=pass",
    });
    expect(c.deliverable).toBe(false);
    expect(c.reasons.some((r) => /dkim/i.test(r))).toBe(true);
  });

  it("is NOT deliverable when config is unaligned even if a stray header passes", () => {
    const c = confirmDeliverability({
      auth: { spf: undefined, dkim: undefined, dmarc: undefined },
      authResultsHeader: "x; spf=pass; dkim=pass; dmarc=pass",
    });
    expect(c.deliverable).toBe(false);
  });
});
