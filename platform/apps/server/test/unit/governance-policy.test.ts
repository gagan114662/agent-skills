import { describe, it, expect } from "vitest";
import {
  ACTION_KINDS,
  APPROVAL_STATUSES,
  DEFAULT_POLICY,
  canResolve,
  evaluatePolicy,
  isActionKind,
  isApprovalStatus,
  isExpired,
  isTerminal,
  type GovernancePolicy,
} from "../../src/governance/policy.js";

describe("governance policy engine (#13)", () => {
  it("exposes the four action kinds and five statuses", () => {
    expect([...ACTION_KINDS]).toEqual(["external_send", "spend", "channel_post", "custom"]);
    expect([...APPROVAL_STATUSES]).toEqual([
      "pending",
      "approved",
      "rejected",
      "expired",
      "auto_approved",
    ]);
  });

  it("type guards narrow valid values and reject junk", () => {
    expect(isActionKind("spend")).toBe(true);
    expect(isActionKind("nope")).toBe(false);
    expect(isApprovalStatus("pending")).toBe(true);
    expect(isApprovalStatus("")).toBe(false);
  });

  it("only a pending request can be resolved; the rest are terminal", () => {
    expect(canResolve("pending")).toBe(true);
    for (const s of ["approved", "rejected", "expired", "auto_approved"] as const) {
      expect(canResolve(s)).toBe(false);
      expect(isTerminal(s)).toBe(true);
    }
    expect(isTerminal("pending")).toBe(false);
  });

  describe("evaluatePolicy", () => {
    it("gates every external_send by default", () => {
      const r = evaluatePolicy({ kind: "external_send", summary: "email the report" }, DEFAULT_POLICY);
      expect(r.required).toBe(true);
      expect(r.reason).toMatch(/external send/i);
    });

    it("does not gate external_send when the policy disables it", () => {
      const policy: GovernancePolicy = { ...DEFAULT_POLICY, externalSendRequiresApproval: false };
      expect(evaluatePolicy({ kind: "external_send", summary: "x" }, policy).required).toBe(false);
    });

    it("gates spend strictly above the threshold, not at or below it", () => {
      const policy: GovernancePolicy = { ...DEFAULT_POLICY, spendThresholdCents: 5000 };
      expect(evaluatePolicy({ kind: "spend", summary: "buy", amountCents: 5001 }, policy).required).toBe(true);
      expect(evaluatePolicy({ kind: "spend", summary: "buy", amountCents: 5000 }, policy).required).toBe(false);
      expect(evaluatePolicy({ kind: "spend", summary: "buy", amountCents: 10 }, policy).required).toBe(false);
    });

    it("gates any positive spend with the default threshold of 0", () => {
      expect(evaluatePolicy({ kind: "spend", summary: "buy", amountCents: 1 }, DEFAULT_POLICY).required).toBe(true);
      // a missing/zero amount is treated as no spend → not gated
      expect(evaluatePolicy({ kind: "spend", summary: "buy" }, DEFAULT_POLICY).required).toBe(false);
    });

    it("gates a channel_post only into a guarded channel", () => {
      const policy: GovernancePolicy = { ...DEFAULT_POLICY, guardedChannelIds: ["chan-1"] };
      expect(evaluatePolicy({ kind: "channel_post", summary: "post", channelId: "chan-1" }, policy).required).toBe(true);
      expect(evaluatePolicy({ kind: "channel_post", summary: "post", channelId: "chan-2" }, policy).required).toBe(false);
      expect(evaluatePolicy({ kind: "channel_post", summary: "post" }, policy).required).toBe(false);
    });

    it("requireApprovalFor forces a kind to always gate, overriding its own lever", () => {
      const policy: GovernancePolicy = {
        ...DEFAULT_POLICY,
        externalSendRequiresApproval: false,
        requireApprovalFor: ["custom", "external_send"],
      };
      expect(evaluatePolicy({ kind: "custom", summary: "anything" }, policy).required).toBe(true);
      // even though externalSendRequiresApproval is off, the explicit list wins
      const r = evaluatePolicy({ kind: "external_send", summary: "x" }, policy);
      expect(r.required).toBe(true);
      expect(r.reason).toMatch(/always requires approval/i);
    });

    it("leaves a plain custom action ungated by default (auto)", () => {
      const r = evaluatePolicy({ kind: "custom", summary: "rename a label" }, DEFAULT_POLICY);
      expect(r.required).toBe(false);
      expect(r.reason).toMatch(/auto/i);
    });
  });

  describe("isExpired", () => {
    const now = new Date("2026-06-08T12:00:00Z");
    it("is false when there is no expiry", () => {
      expect(isExpired(null, now)).toBe(false);
    });
    it("is true once now passes the expiry instant", () => {
      expect(isExpired(new Date("2026-06-08T11:59:59Z"), now)).toBe(true);
      expect(isExpired(new Date("2026-06-08T12:00:01Z"), now)).toBe(false);
    });
  });

  it("DEFAULT_POLICY matches the documented defaults", () => {
    expect(DEFAULT_POLICY).toEqual({
      externalSendRequiresApproval: true,
      spendThresholdCents: 0,
      guardedChannelIds: [],
      requireApprovalFor: [],
      defaultTtlMs: 86_400_000,
    });
  });
});
