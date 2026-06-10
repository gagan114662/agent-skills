import { describe, it, expect } from "vitest";
import { decideAdmission, type AdmissionState } from "../../src/scale/decide.js";

/** A launch that is admissible by default; override one field per test. */
function state(over: Partial<AdmissionState> = {}): AdmissionState {
  return {
    killSwitch: false,
    budgetExceeded: false,
    tenantInFlight: 0,
    tenantMax: 0,
    globalInFlight: 0,
    globalMax: 0,
    ...over,
  };
}

describe("decideAdmission (#71 — launch gate priority)", () => {
  it("admits when under every cap and no hard stop", () => {
    expect(decideAdmission(state())).toEqual({ ok: true });
    expect(decideAdmission(state({ tenantInFlight: 4, tenantMax: 5, globalInFlight: 9, globalMax: 20 }))).toEqual({
      ok: true,
    });
  });

  it("the kill switch wins over everything (immediate halt, #17)", () => {
    const s = state({ killSwitch: true, budgetExceeded: true, tenantInFlight: 9, tenantMax: 1 });
    expect(decideAdmission(s)).toEqual({ ok: false, reason: "kill_switch" });
  });

  it("budget halts before any capacity cap", () => {
    const s = state({ budgetExceeded: true, tenantInFlight: 9, tenantMax: 1, globalInFlight: 99, globalMax: 1 });
    expect(decideAdmission(s)).toEqual({ ok: false, reason: "budget_exceeded" });
  });

  it("denies on per-tenant capacity (at or above the cap) before global", () => {
    expect(decideAdmission(state({ tenantInFlight: 1, tenantMax: 1, globalInFlight: 99, globalMax: 1 }))).toEqual({
      ok: false,
      reason: "tenant_capacity",
    });
    expect(decideAdmission(state({ tenantInFlight: 2, tenantMax: 5 })).ok).toBe(true); // under cap admits
  });

  it("denies on global capacity when the tenant is under its own cap", () => {
    expect(decideAdmission(state({ tenantInFlight: 1, tenantMax: 5, globalInFlight: 20, globalMax: 20 }))).toEqual({
      ok: false,
      reason: "global_capacity",
    });
  });

  it("a 0 cap means unlimited (per-tenant and global)", () => {
    expect(decideAdmission(state({ tenantInFlight: 999, tenantMax: 0, globalInFlight: 999, globalMax: 0 }))).toEqual({
      ok: true,
    });
  });
});
