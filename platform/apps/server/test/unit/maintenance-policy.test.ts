import { describe, it, expect } from "vitest";
import {
  isWriteRequest,
  isAllowlisted,
  shouldRejectWrite,
  MAINTENANCE_ALLOW_PREFIXES,
  type MaintenanceState,
} from "../../src/maintenance/policy.js";

const OFF: MaintenanceState = { enabled: false };
const ON: MaintenanceState = { enabled: true, since: "2026-06-10T00:00:00.000Z" };

describe("isWriteRequest", () => {
  it("treats anything but GET/HEAD/OPTIONS as a write (case-insensitive)", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get", "head", "options"]) {
      expect(isWriteRequest(m)).toBe(false);
    }
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post", "patch"]) {
      expect(isWriteRequest(m)).toBe(true);
    }
  });
});

describe("isAllowlisted", () => {
  it("allows the maintenance control route so you can always turn it back off", () => {
    expect(MAINTENANCE_ALLOW_PREFIXES).toContain("/maintenance");
    expect(isAllowlisted("/maintenance")).toBe(true);
  });
  it("allows health/readiness probes and metrics during maintenance", () => {
    expect(isAllowlisted("/livez")).toBe(true);
    expect(isAllowlisted("/readyz")).toBe(true);
    expect(isAllowlisted("/metrics")).toBe(true);
  });
  it("does not allow an ordinary write route", () => {
    expect(isAllowlisted("/channels/c1/messages")).toBe(false);
  });
});

describe("shouldRejectWrite", () => {
  it("never rejects when maintenance is off", () => {
    expect(shouldRejectWrite(OFF, "POST", "/channels/c1/messages")).toBe(false);
  });

  it("rejects a write when maintenance is on", () => {
    expect(shouldRejectWrite(ON, "POST", "/channels/c1/messages")).toBe(true);
    expect(shouldRejectWrite(ON, "DELETE", "/tasks/t1")).toBe(true);
  });

  it("always allows reads, even during maintenance", () => {
    expect(shouldRejectWrite(ON, "GET", "/channels/c1/messages")).toBe(false);
    expect(shouldRejectWrite(ON, "HEAD", "/me")).toBe(false);
  });

  it("allow-lists the control + probe routes even for writes during maintenance", () => {
    expect(shouldRejectWrite(ON, "POST", "/maintenance")).toBe(false);
  });

  it("FAILS OPEN: a write is admitted when the backing store is unavailable (deliberate)", () => {
    // Even with enabled:true, an unavailable backing store must never produce a write outage.
    const broken: MaintenanceState = { enabled: true, unavailable: true };
    expect(shouldRejectWrite(broken, "POST", "/channels/c1/messages")).toBe(false);
  });
});
