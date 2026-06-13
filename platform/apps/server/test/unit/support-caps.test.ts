import { describe, it, expect } from "vitest";
import { resolveSupportDeskCaps, SUPPORT_DESK_DEFAULTS } from "../../src/support/caps.js";

describe("support/caps — resolve with safe defaults (#190)", () => {
  it("an undefined config resolves to the all-off / conservative defaults", () => {
    const caps = resolveSupportDeskCaps(undefined);
    expect(caps).toEqual(SUPPORT_DESK_DEFAULTS);
    expect(caps.enabled).toBe(false);
    expect(caps.autoSend).toBe(false);
    expect(caps.ownerWorkspaceOnly).toBe(true);
  });

  it("an empty config still yields autoSend OFF (the irreversible default)", () => {
    expect(resolveSupportDeskCaps({}).autoSend).toBe(false);
  });

  it("explicit values override defaults", () => {
    const caps = resolveSupportDeskCaps({
      enabled: true,
      autoSend: true,
      autoSendCategories: ["support", "pricing"],
      ownerWorkspaceOnly: false,
      autoSendMaxPerDay: 5,
      firstResponseSlaMinutes: 30,
      recurringComplaintThreshold: 2,
    });
    expect(caps.autoSend).toBe(true);
    expect(caps.autoSendCategories).toEqual(["support", "pricing"]);
    expect(caps.ownerWorkspaceOnly).toBe(false);
    expect(caps.autoSendMaxPerDay).toBe(5);
    expect(caps.firstResponseSlaMinutes).toBe(30);
    expect(caps.recurringComplaintThreshold).toBe(2);
  });
});
