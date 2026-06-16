import { describe, it, expect } from "vitest";
import {
  evaluatePolicy,
  isExpired,
  isActionType,
  isApprovalStatus,
  isIrreversibleAction,
  isMoneyAction,
  MONEY_ACTIONS,
  DEFAULT_SENSITIVE_ACTIONS,
  IRREVERSIBLE_ACTIONS,
  AUTONOMY_COMPLETE_ACTION,
  DR_RESTORE_ACTION,
  PORTFOLIO_SUNSET_ACTION,
  VENTURE_BOOTSTRAP_ACTION,
  type PolicyRule,
} from "../../src/approvals/policy.js";

/** Money actions: gated by default. Non-money: autonomous (#243 owner decision). */
const MONEY = [
  "billing.refund",
  "billing.payout",
  "billing.transfer",
  "finance.disbursement",
  "venture.domain_purchase",
  "venture.ad_spend",
  "venture.payment_method",
  "monetization.activate_price",
  "monetization.payout_settings",
  "setup.external_account",
  "reach.data_credit_spend",
];
const NON_MONEY = [
  "external.send",
  "outreach.send",
  "realworld.publish",
  "venture.deploy",
  "venture.bootstrap",
  "portfolio.sunset",
  "dr.restore",
  "autonomy.complete",
  "browser.action",
  "chat.post_message",
];
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

  it("drives approval off a single MONEY predicate: money gates, everything else is autonomous (#243)", () => {
    // Money actions gate by default (no rule), with no owner prompt needed for anything else.
    for (const a of MONEY) {
      expect(isMoneyAction(a), a).toBe(true);
      expect(DEFAULT_SENSITIVE_ACTIONS, a).toContain(a);
      expect(evaluatePolicy({ actionType: a }, []).requiresApproval, a).toBe(true);
    }
    // Non-money actions (sends, posts, publish, deploy, bootstrap, sunset, restore, complete, browser)
    // run autonomously by default — the owner sees no approval prompt.
    for (const a of NON_MONEY) {
      expect(isMoneyAction(a), a).toBe(false);
      expect(DEFAULT_SENSITIVE_ACTIONS, a).not.toContain(a);
      expect(evaluatePolicy({ actionType: a }, []).requiresApproval, a).toBe(false);
    }
  });

  it("a workspace rule can still opt a non-money action back into a gate (#243)", () => {
    // The fleet is autonomous by default, but a cautious workspace can re-gate any action explicitly.
    const gated: PolicyRule[] = [
      { actionType: AUTONOMY_COMPLETE_ACTION, requiresApproval: true, maxAutoAmount: null },
    ];
    expect(evaluatePolicy({ actionType: AUTONOMY_COMPLETE_ACTION }, gated).requiresApproval).toBe(
      true,
    );
    // dr.restore is no longer gated by default (only money gates) — but a rule can bring the gate back.
    expect(evaluatePolicy({ actionType: DR_RESTORE_ACTION }, []).requiresApproval).toBe(false);
    const drGated: PolicyRule[] = [
      { actionType: DR_RESTORE_ACTION, requiresApproval: true, maxAutoAmount: null },
    ];
    expect(evaluatePolicy({ actionType: DR_RESTORE_ACTION }, drGated).requiresApproval).toBe(true);
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

describe("isIrreversibleAction (premortem #200 FM#4 — money-only under #243)", () => {
  it("classifies irreversible MONEY actions as irreversible", () => {
    expect(isIrreversibleAction("billing.refund")).toBe(true);
    expect(isIrreversibleAction("finance.disbursement")).toBe(true);
    expect(isIrreversibleAction("venture.domain_purchase")).toBe(true);
    expect(isIrreversibleAction("venture.ad_spend")).toBe(true);
    expect(isIrreversibleAction("venture.payment_method")).toBe(true);
  });

  it("does NOT mark now-autonomous (non-money) or reversible/read actions as irreversible", () => {
    // Under #243 a sent message / a kill / a destructive restore are no longer gated, so they are no
    // longer counted as irreversible owner-exposure — only money is.
    expect(isIrreversibleAction("external.send")).toBe(false);
    expect(isIrreversibleAction("outreach.send")).toBe(false);
    expect(isIrreversibleAction(PORTFOLIO_SUNSET_ACTION)).toBe(false);
    expect(isIrreversibleAction(DR_RESTORE_ACTION)).toBe(false);
    expect(isIrreversibleAction(VENTURE_BOOTSTRAP_ACTION)).toBe(false);
    expect(isIrreversibleAction("browser.action")).toBe(false);
    expect(isIrreversibleAction("chat.post_message")).toBe(false);
    expect(isIrreversibleAction("unknown.thing")).toBe(false);
  });

  it("every irreversible action is also a gated money action (human-gated, never post-hoc)", () => {
    for (const a of IRREVERSIBLE_ACTIONS) {
      expect(isMoneyAction(a)).toBe(true);
      expect(DEFAULT_SENSITIVE_ACTIONS).toContain(a);
    }
  });

  it("the gated-by-default set is exactly the money set (single MONEY predicate, #243)", () => {
    expect([...DEFAULT_SENSITIVE_ACTIONS].sort()).toEqual([...MONEY_ACTIONS].sort());
    expect([...MONEY_ACTIONS].sort()).toEqual([...MONEY].sort());
  });
});
