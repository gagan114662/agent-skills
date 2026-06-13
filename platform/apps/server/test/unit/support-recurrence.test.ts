import { describe, it, expect } from "vitest";
import { fingerprintComplaint, shouldFileComplaintIssue } from "../../src/support/recurrence.js";
import { SUPPORT_DESK_DEFAULTS } from "../../src/support/caps.js";

describe("support/recurrence — recurring complaints → one deduped backlog issue (#190)", () => {
  it("the same complaint shape collides to one stable signature (volatile tokens stripped)", () => {
    const a = fingerprintComplaint({ category: "bug", subject: "Export fails", body: "export failed at 12:01 for order 8831" });
    const b = fingerprintComplaint({ category: "bug", subject: "Export fails", body: "export failed at 09:42 for order 2210" });
    expect(a.signature).toBe(b.signature);
  });

  it("different categories of the same text are different fingerprints", () => {
    const a = fingerprintComplaint({ category: "bug", subject: null, body: "it broke" });
    const b = fingerprintComplaint({ category: "pricing", subject: null, body: "it broke" });
    expect(a.signature).not.toBe(b.signature);
  });

  it("the title carries the customer_complaint class marker", () => {
    expect(fingerprintComplaint({ category: "bug", subject: "Slow", body: "slow" }).title).toContain("customer_complaint");
  });

  it("does not file below the threshold, files at/above it", () => {
    const caps = { ...SUPPORT_DESK_DEFAULTS, recurringComplaintThreshold: 3 };
    expect(shouldFileComplaintIssue(1, caps)).toBe(false);
    expect(shouldFileComplaintIssue(2, caps)).toBe(false);
    expect(shouldFileComplaintIssue(3, caps)).toBe(true);
    expect(shouldFileComplaintIssue(4, caps)).toBe(true);
  });
});
