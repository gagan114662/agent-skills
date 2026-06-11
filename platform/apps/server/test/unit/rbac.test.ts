import { describe, it, expect } from "vitest";
import {
  isWorkspaceRole,
  roleRank,
  roleSatisfies,
  canClearApprovals,
  canManageGovernance,
  isReadOnly,
  isLikelyEmail,
  decideInvite,
  decideApprovalClear,
  decideRoleChange,
  resolveRbacConfig,
} from "../../src/team/rbac.js";

describe("rbac (#151 — workspace roles)", () => {
  it("ranks owner > approver > viewer", () => {
    expect(roleRank("owner")).toBeGreaterThan(roleRank("approver"));
    expect(roleRank("approver")).toBeGreaterThan(roleRank("viewer"));
    expect(roleSatisfies("owner", "approver")).toBe(true);
    expect(roleSatisfies("viewer", "approver")).toBe(false);
  });

  it("only approver/owner may clear approvals; viewer cannot", () => {
    expect(canClearApprovals("owner")).toBe(true);
    expect(canClearApprovals("approver")).toBe(true);
    expect(canClearApprovals("viewer")).toBe(false);
  });

  it("only owner manages governance; viewer is read-only", () => {
    expect(canManageGovernance("owner")).toBe(true);
    expect(canManageGovernance("approver")).toBe(false);
    expect(isReadOnly("viewer")).toBe(true);
    expect(isReadOnly("owner")).toBe(false);
  });

  it("validates role input", () => {
    expect(isWorkspaceRole("owner")).toBe(true);
    expect(isWorkspaceRole("admin")).toBe(false);
    expect(isWorkspaceRole(null)).toBe(false);
  });

  describe("decideInvite", () => {
    it("accepts a valid email + role, normalising the email", () => {
      expect(decideInvite({ email: " Alice@Example.com ", role: "approver" })).toEqual({
        ok: true,
        email: "alice@example.com",
        role: "approver",
      });
    });
    it("rejects a bad email", () => {
      expect(decideInvite({ email: "not-an-email", role: "viewer" }).ok).toBe(false);
      expect(isLikelyEmail("a@b")).toBe(false);
      expect(isLikelyEmail("a@b.co")).toBe(true);
    });
    it("rejects an unknown role", () => {
      expect(decideInvite({ email: "a@b.co", role: "superuser" }).ok).toBe(false);
    });
  });

  describe("decideApprovalClear (no weakening of existing gates)", () => {
    it("RBAC disabled → allow regardless of role (today's behavior)", () => {
      expect(decideApprovalClear({ rbacEnabled: false, role: null }).decision).toBe("allow");
      expect(decideApprovalClear({ rbacEnabled: false, role: "viewer" }).decision).toBe("allow");
    });
    it("RBAC enabled + no role row → allow (turning RBAC on never silently locks anyone out)", () => {
      expect(decideApprovalClear({ rbacEnabled: true, role: null }).decision).toBe("allow");
    });
    it("RBAC enabled + approver/owner → allow", () => {
      expect(decideApprovalClear({ rbacEnabled: true, role: "approver" }).decision).toBe("allow");
      expect(decideApprovalClear({ rbacEnabled: true, role: "owner" }).decision).toBe("allow");
    });
    it("RBAC enabled + viewer → deny with a reason", () => {
      const d = decideApprovalClear({ rbacEnabled: true, role: "viewer" });
      expect(d.decision).toBe("deny");
      expect(d.reason).toMatch(/approver or owner/);
    });
  });

  it("resolveRbacConfig defaults to OFF", () => {
    expect(resolveRbacConfig(undefined)).toEqual({ enabled: false });
    expect(resolveRbacConfig({ enabled: true })).toEqual({ enabled: true });
  });

  describe("decideRoleChange — owner-role protection (review fix)", () => {
    const owner = {
      callerRole: "owner" as const,
      callerKind: "human" as const,
      ownerExists: true,
      ownerCount: 2,
    };

    it("bootstrap: a human may set the FIRST owner when none exists", () => {
      expect(
        decideRoleChange({
          callerRole: null,
          callerKind: "human",
          ownerExists: false,
          targetCurrentRole: null,
          newRole: "owner",
          ownerCount: 0,
        }),
      ).toEqual({ ok: true });
    });

    it("an approver (non-owner) cannot demote the owner → 403", () => {
      const d = decideRoleChange({
        callerRole: "approver",
        callerKind: "human",
        ownerExists: true,
        targetCurrentRole: "owner",
        newRole: "viewer",
        ownerCount: 1,
      });
      expect(d).toEqual({ ok: false, status: 403, reason: expect.stringMatching(/owner/i) });
    });

    it("an approver cannot grant the owner role to anyone → 403", () => {
      const d = decideRoleChange({
        callerRole: "approver",
        callerKind: "human",
        ownerExists: true,
        targetCurrentRole: null,
        newRole: "owner",
        ownerCount: 1,
      });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.status).toBe(403);
    });

    it("the SOLE owner cannot demote themselves → 409", () => {
      const d = decideRoleChange({
        ...owner,
        ownerCount: 1,
        targetCurrentRole: "owner",
        newRole: "viewer",
      });
      expect(d).toEqual({ ok: false, status: 409, reason: expect.stringMatching(/at least one owner/i) });
    });

    it("the SOLE owner cannot be removed (DELETE) → 409", () => {
      const d = decideRoleChange({
        ...owner,
        ownerCount: 1,
        targetCurrentRole: "owner",
        newRole: null,
      });
      expect(d).toEqual({ ok: false, status: 409, reason: expect.stringMatching(/at least one owner/i) });
    });

    it("an owner CAN demote another owner when others remain", () => {
      expect(
        decideRoleChange({ ...owner, ownerCount: 2, targetCurrentRole: "owner", newRole: "approver" }),
      ).toEqual({ ok: true });
    });

    it("an owner CAN grant the owner role to a teammate", () => {
      expect(
        decideRoleChange({ ...owner, targetCurrentRole: "viewer", newRole: "owner" }),
      ).toEqual({ ok: true });
    });

    it("an owner managing a non-owner role is unaffected", () => {
      expect(
        decideRoleChange({ ...owner, targetCurrentRole: null, newRole: "viewer" }),
      ).toEqual({ ok: true });
    });

    it("a non-owner with no bootstrap (owner exists) is denied any change → 403", () => {
      const d = decideRoleChange({
        callerRole: "viewer",
        callerKind: "human",
        ownerExists: true,
        targetCurrentRole: null,
        newRole: "viewer",
        ownerCount: 1,
      });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.status).toBe(403);
    });
  });
});
