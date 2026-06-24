import { describe, expect, it } from "vitest";
import { formatApprovalExpiry, normalizeTimeZone } from "../../src/approvals/expiry-timezone.js";

describe("approval expiry timezone display", () => {
  it("labels a 24-hour approval TTL in the tenant timezone", () => {
    const submittedAt = new Date("2026-06-24T04:00:00.000Z");
    const expiresAt = new Date(submittedAt.getTime() + 24 * 60 * 60 * 1000);

    const view = formatApprovalExpiry(expiresAt, "Australia/Sydney");

    expect(view.expiresAt).toBe("2026-06-25T04:00:00.000Z");
    expect(view.expiresAtTimezone).toBe("Australia/Sydney");
    expect(view.expiresAtLabel).toContain("2:00 PM");
    expect(view.expiresAtLabel).toContain("GMT+10");
    expect(view.expiresAtLabel).toContain("Australia/Sydney");
  });

  it("falls back to UTC for blank or invalid tenant timezones", () => {
    expect(normalizeTimeZone("")).toBe("UTC");
    expect(normalizeTimeZone("Mars/Olympus")).toBe("UTC");

    const view = formatApprovalExpiry(new Date("2026-06-25T04:00:00.000Z"), "Mars/Olympus");

    expect(view.expiresAtTimezone).toBe("UTC");
    expect(view.expiresAtLabel).toContain("UTC");
  });

  it("keeps non-expiring approval records explicit", () => {
    expect(formatApprovalExpiry(null, "Australia/Sydney")).toEqual({
      expiresAt: null,
      expiresAtTimezone: "Australia/Sydney",
      expiresAtLabel: null,
    });
  });
});
