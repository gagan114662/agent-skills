import { describe, it, expect } from "vitest";
import {
  decideAutonomousSend,
  type AutonomousSendInput,
} from "../../src/acquisition/autonomous-send.js";
import {
  resolveAutonomousSendCaps,
  AUTONOMOUS_SEND_DEFAULTS,
  isAutonomousSendEnabledForWorkspace,
} from "../../src/acquisition/autonomous-send-caps.js";

/** A fully-compliant, in-cap input — every branch test tweaks one field off this base. */
function base(overrides: Partial<AutonomousSendInput> = {}): AutonomousSendInput {
  return {
    autonomousEnabled: true,
    sentInWindow: 0,
    windowCap: 10,
    hardDailyCap: 100,
    sentToday: 0,
    complianceOk: true,
    recipientSuppressed: false,
    withinWarmupRamp: false,
    ...overrides,
  };
}

describe("decideAutonomousSend", () => {
  it("OFF → gate_13 (today's per-send human gate, even when in-cap + compliant)", () => {
    const d = decideAutonomousSend(base({ autonomousEnabled: false }));
    expect(d.action).toBe("gate_13");
    expect(d.reason).toMatch(/not enabled/i);
  });

  it("suppressed recipient → blocked (compliance always wins, never autonomous)", () => {
    const d = decideAutonomousSend(base({ recipientSuppressed: true }));
    expect(d.action).toBe("blocked");
    expect(d.reason).toMatch(/suppressed/i);
  });

  it("compliance fail → blocked (even with cap headroom)", () => {
    const d = decideAutonomousSend(base({ complianceOk: false }));
    expect(d.action).toBe("blocked");
    expect(d.reason).toMatch(/compliance/i);
  });

  it("suppressed wins even if compliance also fails (both bad → blocked)", () => {
    const d = decideAutonomousSend(base({ recipientSuppressed: true, complianceOk: false }));
    expect(d.action).toBe("blocked");
  });

  it("enabled + compliant + inside both caps → send_autonomous (no human)", () => {
    const d = decideAutonomousSend(base({ sentInWindow: 3, sentToday: 40 }));
    expect(d.action).toBe("send_autonomous");
    expect(d.reason).toMatch(/within caps/i);
  });

  it("notes warmup ramp in the autonomous reason", () => {
    const d = decideAutonomousSend(base({ withinWarmupRamp: true }));
    expect(d.action).toBe("send_autonomous");
    expect(d.reason).toMatch(/warming/i);
  });

  it("over the window cap → gate_13 (escalate to human, not blocked)", () => {
    const d = decideAutonomousSend(base({ sentInWindow: 10, windowCap: 10 }));
    expect(d.action).toBe("gate_13");
    expect(d.reason).toMatch(/window cap reached/i);
  });

  it("at the window cap boundary (sentInWindow === windowCap) → gate_13", () => {
    expect(decideAutonomousSend(base({ sentInWindow: 9, windowCap: 10 })).action).toBe("send_autonomous");
    expect(decideAutonomousSend(base({ sentInWindow: 10, windowCap: 10 })).action).toBe("gate_13");
  });

  it("over the hard daily cap → gate_13 (the never-exceed backstop escalates, never auto-exceeds)", () => {
    const d = decideAutonomousSend(base({ sentToday: 100, hardDailyCap: 100 }));
    expect(d.action).toBe("gate_13");
    expect(d.reason).toMatch(/hard daily cap reached/i);
  });

  it("daily cap is the binding constraint even with window headroom", () => {
    const d = decideAutonomousSend(base({ sentInWindow: 0, windowCap: 10, sentToday: 100, hardDailyCap: 100 }));
    expect(d.action).toBe("gate_13");
    expect(d.reason).toMatch(/daily/i);
  });

  it("a zero window cap grants no autonomous headroom → gate_13", () => {
    expect(decideAutonomousSend(base({ windowCap: 0 })).action).toBe("gate_13");
  });

  it("a zero hard daily cap grants no autonomous headroom → gate_13", () => {
    expect(decideAutonomousSend(base({ hardDailyCap: 0 })).action).toBe("gate_13");
  });

  it("compliance fail beats over-cap (blocked, not gate_13) — compliance always wins", () => {
    const d = decideAutonomousSend(base({ complianceOk: false, sentInWindow: 99, windowCap: 10 }));
    expect(d.action).toBe("blocked");
  });

  it("is total over the full branch matrix (never throws, always a valid action)", () => {
    const bools = [true, false];
    for (const autonomousEnabled of bools)
      for (const complianceOk of bools)
        for (const recipientSuppressed of bools)
          for (const sentInWindow of [0, 5, 10])
            for (const sentToday of [0, 50, 100]) {
              const d = decideAutonomousSend(
                base({ autonomousEnabled, complianceOk, recipientSuppressed, sentInWindow, sentToday }),
              );
              expect(["send_autonomous", "gate_13", "blocked"]).toContain(d.action);
            }
  });
});

describe("resolveAutonomousSendCaps", () => {
  it("defaults everything OFF / zero-cap (fail-closed — nothing sends autonomously)", () => {
    const caps = resolveAutonomousSendCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.ownerWorkspaceOnly).toBe(true);
    expect(caps.windowCap).toBe(0);
    expect(caps.hardDailyCap).toBe(0);
  });

  it("an empty block resolves to the defaults", () => {
    expect(resolveAutonomousSendCaps({})).toEqual(AUTONOMOUS_SEND_DEFAULTS);
  });

  it("applies overrides and truncates non-integer / drops non-positive caps", () => {
    const caps = resolveAutonomousSendCaps({
      enabled: true,
      ownerWorkspaceId: "ws-1",
      windowCap: 25,
      hardDailyCap: 500,
    });
    expect(caps.enabled).toBe(true);
    expect(caps.ownerWorkspaceId).toBe("ws-1");
    expect(caps.windowCap).toBe(25);
    expect(caps.hardDailyCap).toBe(500);
  });

  it("a negative/zero cap normalizes to 0 (no autonomous headroom)", () => {
    expect(resolveAutonomousSendCaps({ windowCap: 0, hardDailyCap: -5 }).windowCap).toBe(0);
    expect(resolveAutonomousSendCaps({ windowCap: 0, hardDailyCap: -5 }).hardDailyCap).toBe(0);
  });
});

describe("isAutonomousSendEnabledForWorkspace", () => {
  it("default OFF → never active", () => {
    expect(isAutonomousSendEnabledForWorkspace(resolveAutonomousSendCaps(undefined), "ws-1")).toBe(false);
  });

  it("enabled + owner-only → active only for the named owner workspace", () => {
    const caps = resolveAutonomousSendCaps({ enabled: true, ownerWorkspaceId: "ws-owner" });
    expect(isAutonomousSendEnabledForWorkspace(caps, "ws-owner")).toBe(true);
    expect(isAutonomousSendEnabledForWorkspace(caps, "ws-other")).toBe(false);
  });

  it("enabled without an owner id (owner-only) → active for NObody", () => {
    const caps = resolveAutonomousSendCaps({ enabled: true });
    expect(isAutonomousSendEnabledForWorkspace(caps, "ws-owner")).toBe(false);
  });

  it("ownerWorkspaceOnly:false → active for all tenants once enabled", () => {
    const caps = resolveAutonomousSendCaps({ enabled: true, ownerWorkspaceOnly: false });
    expect(isAutonomousSendEnabledForWorkspace(caps, "ws-any")).toBe(true);
  });
});
