import { describe, it, expect } from "vitest";
import { decideChannelSend } from "../../src/outbound-channel/send-gate.js";

const base = {
  channel: "email_postmark" as const,
  connectionStatus: "connected" as const,
  flagLive: true,
  approvalRequestId: "req-1",
};

describe("decideChannelSend (#395 / #200 §3-§4 structural always-gate)", () => {
  it("proceeds only when flags live + connected + approval id present", () => {
    const d = decideChannelSend(base);
    expect(d.proceed).toBe(true);
    expect(d.code).toBe("proceed");
  });

  it("refuses when the flags are disabled", () => {
    const d = decideChannelSend({ ...base, flagLive: false });
    expect(d.proceed).toBe(false);
    expect(d.code).toBe("flag_disabled");
  });

  it("refuses when the channel is not connected", () => {
    expect(decideChannelSend({ ...base, connectionStatus: null }).code).toBe("channel_not_connected");
    expect(decideChannelSend({ ...base, connectionStatus: "pending" }).code).toBe("channel_not_connected");
    expect(decideChannelSend({ ...base, connectionStatus: "revoked" }).code).toBe("channel_not_connected");
  });

  it("NEVER proceeds without an owner approval id (no autonomous path)", () => {
    expect(decideChannelSend({ ...base, approvalRequestId: undefined }).proceed).toBe(false);
    expect(decideChannelSend({ ...base, approvalRequestId: null }).proceed).toBe(false);
    expect(decideChannelSend({ ...base, approvalRequestId: "" }).proceed).toBe(false);
    expect(decideChannelSend({ ...base, approvalRequestId: "   " }).code).toBe("approval_required");
  });

  it("never leaks internal chatter in the reason", () => {
    for (const d of [
      decideChannelSend({ ...base, flagLive: false }),
      decideChannelSend({ ...base, connectionStatus: null }),
      decideChannelSend({ ...base, approvalRequestId: "" }),
    ]) {
      expect(d.reason).toBeTruthy();
      expect(d.reason.toLowerCase()).not.toContain("agent");
    }
  });
});
