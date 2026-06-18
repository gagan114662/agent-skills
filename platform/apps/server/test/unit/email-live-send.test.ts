import { describe, it, expect } from "vitest";
import {
  isLiveSendEnabledForWorkspace,
  decidePostmarkLiveSend,
  type LiveSendRequest,
} from "../../src/email/live-send.js";
import { EMAIL_LIVE_SEND_ACTION } from "../../src/approvals/policy.js";
import type { EmailDeliverabilityConfig } from "../../src/config/schema.js";

describe("isLiveSendEnabledForWorkspace (default OFF, owner-workspace-first)", () => {
  it("is OFF for an empty config (the byte-for-byte default — no real email ever)", () => {
    expect(isLiveSendEnabledForWorkspace({}, "ws-1")).toBe(false);
  });

  it("stays owner-workspace-first by default: enabled only matches the owner workspace", () => {
    const cfg: EmailDeliverabilityConfig = { liveSendEnabled: true, ownerWorkspaceId: "owner-ws" };
    expect(isLiveSendEnabledForWorkspace(cfg, "owner-ws")).toBe(true);
    expect(isLiveSendEnabledForWorkspace(cfg, "some-other-ws")).toBe(false);
  });

  it("enabling without naming the owner workspace provisions it for nobody", () => {
    expect(isLiveSendEnabledForWorkspace({ liveSendEnabled: true }, "ws-1")).toBe(false);
  });

  it("can be broadened to every workspace with ownerWorkspaceOnly:false", () => {
    const cfg: EmailDeliverabilityConfig = { liveSendEnabled: true, ownerWorkspaceOnly: false };
    expect(isLiveSendEnabledForWorkspace(cfg, "any-ws")).toBe(true);
  });
});

describe("decidePostmarkLiveSend (structural #13 always-gate, #200 §4)", () => {
  const ok: LiveSendRequest = {
    workspaceId: "owner-ws",
    config: { liveSendEnabled: true, ownerWorkspaceId: "owner-ws" },
    complianceOk: true,
    deliverability: { deliverable: true } as LiveSendRequest["deliverability"],
    sendBudget: { allowed: true, grantable: 10, reason: "ok" },
    contentQuarantined: true,
    approvalRequestId: null,
  };

  it("uses the email.live_send action and is NEVER autonomous (always requires approval)", () => {
    const v = decidePostmarkLiveSend(ok);
    expect(v.action).toBe(EMAIL_LIVE_SEND_ACTION);
    expect(v.requiresApproval).toBe(true);
  });

  it("is eligible-but-not-proceeding while unapproved (pre-commit, owner must say yes)", () => {
    const v = decidePostmarkLiveSend(ok);
    expect(v.eligible).toBe(true);
    expect(v.proceed).toBe(false);
    expect(v.blockers).toEqual([]);
  });

  it("proceeds ONLY once an owner approval id is attached AND all gates pass", () => {
    const v = decidePostmarkLiveSend({ ...ok, approvalRequestId: "appr-123" });
    expect(v.proceed).toBe(true);
  });

  it("never proceeds (even approved) when the flag is off for the workspace", () => {
    const v = decidePostmarkLiveSend({ ...ok, workspaceId: "other-ws", approvalRequestId: "appr-123" });
    expect(v.eligible).toBe(false);
    expect(v.proceed).toBe(false);
    expect(v.blockers.some((b) => /not enabled/i.test(b))).toBe(true);
  });

  it("blocks when deliverability is unconfirmed (#200 §3 — never assume SPF/DKIM/DMARC)", () => {
    const v = decidePostmarkLiveSend({
      ...ok,
      approvalRequestId: "appr-123",
      deliverability: { deliverable: false } as LiveSendRequest["deliverability"],
    });
    expect(v.proceed).toBe(false);
    expect(v.blockers.some((b) => /deliverab/i.test(b))).toBe(true);
  });

  it("blocks when the email failed the compliance check", () => {
    const v = decidePostmarkLiveSend({ ...ok, approvalRequestId: "appr-123", complianceOk: false });
    expect(v.proceed).toBe(false);
    expect(v.blockers.some((b) => /complian/i.test(b))).toBe(true);
  });

  it("blocks when there is no send-budget headroom (warmup / rate cap)", () => {
    const v = decidePostmarkLiveSend({
      ...ok,
      approvalRequestId: "appr-123",
      sendBudget: { allowed: false, grantable: 0, reason: "warmup full" },
    });
    expect(v.proceed).toBe(false);
    expect(v.blockers.some((b) => /cap|warmup|budget/i.test(b))).toBe(true);
  });

  it("blocks when externally-sourced content was not quarantined (#200 §6 injection defense)", () => {
    const v = decidePostmarkLiveSend({ ...ok, approvalRequestId: "appr-123", contentQuarantined: false });
    expect(v.proceed).toBe(false);
    expect(v.blockers.some((b) => /quarantin|inject/i.test(b))).toBe(true);
  });
});
