import { describe, it, expect } from "vitest";
import {
  evaluatePolicy,
  isExpired,
  isActionType,
  isApprovalStatus,
  DEFAULT_SENSITIVE_ACTIONS,
  AUTONOMY_COMPLETE_ACTION,
  DR_RESTORE_ACTION,
  type PolicyRule,
} from "../../src/approvals/policy.js";
import {
  buildRegistry,
  validateChatPostMessage,
  validateExternalSend,
  type ActionExecutor,
} from "../../src/approvals/executor.js";

describe("evaluatePolicy (gating engine)", () => {
  it("gates an action whose rule requires approval", () => {
    const rules: PolicyRule[] = [
      { actionType: "chat.post_message", requiresApproval: true, maxAutoAmount: null },
    ];
    const d = evaluatePolicy({ actionType: "chat.post_message" }, rules);
    expect(d.requiresApproval).toBe(true);
  });

  it("auto-approves an action whose rule does not require approval", () => {
    const rules: PolicyRule[] = [
      { actionType: "chat.post_message", requiresApproval: false, maxAutoAmount: null },
    ];
    expect(evaluatePolicy({ actionType: "chat.post_message" }, rules).requiresApproval).toBe(false);
  });

  it("re-gates an otherwise-auto action when amount exceeds the spend threshold", () => {
    const rules: PolicyRule[] = [
      { actionType: "external.send", requiresApproval: false, maxAutoAmount: 100 },
    ];
    expect(evaluatePolicy({ actionType: "external.send", amount: 50 }, rules).requiresApproval).toBe(
      false,
    );
    const over = evaluatePolicy({ actionType: "external.send", amount: 150 }, rules);
    expect(over.requiresApproval).toBe(true);
    expect(over.reason).toContain("exceeds");
    // exactly at the threshold is still auto (strictly greater gates)
    expect(evaluatePolicy({ actionType: "external.send", amount: 100 }, rules).requiresApproval).toBe(
      false,
    );
  });

  it("falls back to DEFAULT_SENSITIVE_ACTIONS when no rule matches", () => {
    expect(DEFAULT_SENSITIVE_ACTIONS).toContain("external.send");
    expect(evaluatePolicy({ actionType: "external.send" }, []).requiresApproval).toBe(true);
    expect(evaluatePolicy({ actionType: "chat.post_message" }, []).requiresApproval).toBe(false);
  });

  it("gates autonomy.complete by default so the human gate stays unless a rule opts in (#84/ADR-0042)", () => {
    // No rule → the autonomous-completion gate holds (today's behaviour, exactly).
    expect(DEFAULT_SENSITIVE_ACTIONS).toContain(AUTONOMY_COMPLETE_ACTION);
    expect(evaluatePolicy({ actionType: AUTONOMY_COMPLETE_ACTION }, []).requiresApproval).toBe(true);
    // An explicit auto-approve rule opts the workspace out of the human gate.
    const auto: PolicyRule[] = [
      { actionType: AUTONOMY_COMPLETE_ACTION, requiresApproval: false, maxAutoAmount: null },
    ];
    expect(evaluatePolicy({ actionType: AUTONOMY_COMPLETE_ACTION }, auto).requiresApproval).toBe(
      false,
    );
    // A rule that still requires approval keeps the gate.
    const gated: PolicyRule[] = [
      { actionType: AUTONOMY_COMPLETE_ACTION, requiresApproval: true, maxAutoAmount: null },
    ];
    expect(evaluatePolicy({ actionType: AUTONOMY_COMPLETE_ACTION }, gated).requiresApproval).toBe(
      true,
    );
  });

  it("gates dr.restore by default so a destructive restore always needs a human (#99)", () => {
    // No rule → a DISASTER restore requires explicit #13 approval; an agent can never self-approve.
    expect(DEFAULT_SENSITIVE_ACTIONS).toContain(DR_RESTORE_ACTION);
    expect(evaluatePolicy({ actionType: DR_RESTORE_ACTION }, []).requiresApproval).toBe(true);
  });
});

describe("isExpired", () => {
  const now = new Date("2026-06-08T12:00:00.000Z");
  it("never expires a null deadline", () => {
    expect(isExpired(null, now)).toBe(false);
  });
  it("expires once the deadline has passed (inclusive)", () => {
    expect(isExpired(new Date("2026-06-08T11:59:59.000Z"), now)).toBe(true);
    expect(isExpired(new Date("2026-06-08T12:00:00.000Z"), now)).toBe(true);
    expect(isExpired(new Date("2026-06-08T12:00:01.000Z"), now)).toBe(false);
  });
});

describe("type guards", () => {
  it("isActionType accepts known types only", () => {
    expect(isActionType("chat.post_message")).toBe(true);
    expect(isActionType("external.send")).toBe(true);
    expect(isActionType("rm -rf")).toBe(false);
    expect(isActionType(undefined)).toBe(false);
  });
  it("isApprovalStatus accepts the lifecycle states only", () => {
    for (const s of ["pending", "approved", "executed", "failed", "rejected", "expired"]) {
      expect(isApprovalStatus(s)).toBe(true);
    }
    expect(isApprovalStatus("bogus")).toBe(false);
  });
});

describe("payload validators", () => {
  it("chat.post_message requires non-empty channelId + body", () => {
    expect(validateChatPostMessage({ channelId: "c1", body: "hi" })).toEqual({ ok: true });
    expect(validateChatPostMessage({ channelId: "c1" }).ok).toBe(false);
    expect(validateChatPostMessage({ channelId: "", body: "hi" }).ok).toBe(false);
    expect(validateChatPostMessage(null).ok).toBe(false);
    expect(validateChatPostMessage("nope").ok).toBe(false);
  });

  it("external.send requires a summary; target is optional", () => {
    expect(validateExternalSend({ summary: "ping ops" })).toEqual({ ok: true });
    expect(validateExternalSend({ summary: "ping", target: "ops@x.com" })).toEqual({ ok: true });
    expect(validateExternalSend({ target: "ops@x.com" }).ok).toBe(false);
    expect(validateExternalSend({ summary: "ping", target: 42 }).ok).toBe(false);
  });
});

describe("executor registry", () => {
  const fake: ActionExecutor = {
    actionType: "chat.post_message",
    validate: () => ({ ok: true }),
    summarize: () => "x",
    execute: async () => ({ done: true }),
  };

  it("looks up an executor by action type and misses unknown types", () => {
    const reg = buildRegistry([fake]);
    expect(reg.get("chat.post_message")).toBe(fake);
    expect(reg.get("external.send")).toBeUndefined();
  });

  it("later entries win on a duplicate type", () => {
    const other: ActionExecutor = { ...fake, summarize: () => "y" };
    const reg = buildRegistry([fake, other]);
    expect(reg.get("chat.post_message")).toBe(other);
  });
});
