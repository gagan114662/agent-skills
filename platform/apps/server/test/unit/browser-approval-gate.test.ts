import { describe, it, expect } from "vitest";
import {
  storeBackedApprovalGate,
  type BrowserApprovalKey,
  type BrowserApprovalStore,
  type MatchedApproval,
} from "../../src/runtime/browser/approval-default.js";
import type { BrowserApprovalRequest } from "../../src/runtime/browser/approval.js";
import { validateBrowserAction } from "../../src/approvals/executor.js";
import { DEFAULT_SENSITIVE_ACTIONS, evaluatePolicy, isActionType } from "../../src/approvals/policy.js";

function fakeStore(seed?: { approved?: boolean; pending?: boolean }): BrowserApprovalStore & {
  created: BrowserApprovalRequest[];
} {
  const created: BrowserApprovalRequest[] = [];
  return {
    created,
    async findApproved(_key: BrowserApprovalKey): Promise<MatchedApproval | null> {
      return seed?.approved ? { approvalRequestId: "appr-existing" } : null;
    },
    async findPending(_key: BrowserApprovalKey): Promise<MatchedApproval | null> {
      return seed?.pending ? { approvalRequestId: "pend-existing" } : null;
    },
    async createPending(request: BrowserApprovalRequest): Promise<MatchedApproval> {
      created.push(request);
      return { approvalRequestId: "pend-new" };
    },
  };
}

const REQ: BrowserApprovalRequest = {
  workspaceId: "w1",
  sessionId: "s1",
  tool: "click",
  target: "https://shop.example.com/cart",
  summary: "click #checkout",
};

describe("storeBackedApprovalGate (#174 — #13 wiring)", () => {
  it("approves when a human has already approved the exact action", async () => {
    const store = fakeStore({ approved: true });
    const d = await storeBackedApprovalGate(store).ensure(REQ);
    expect(d.approved).toBe(true);
    expect(d.approvalRequestId).toBe("appr-existing");
    expect(store.created).toHaveLength(0);
  });

  it("stays pending (no duplicate) when a request is already on the queue", async () => {
    const store = fakeStore({ pending: true });
    const d = await storeBackedApprovalGate(store).ensure(REQ);
    expect(d.approved).toBe(false);
    expect(d.approvalRequestId).toBe("pend-existing");
    expect(store.created).toHaveLength(0);
  });

  it("raises a new pending request when none exists and refuses", async () => {
    const store = fakeStore();
    const d = await storeBackedApprovalGate(store).ensure(REQ);
    expect(d.approved).toBe(false);
    expect(d.approvalRequestId).toBe("pend-new");
    expect(store.created).toEqual([REQ]);
  });
});

describe("browser.action as a #13 citizen (#174)", () => {
  it("is a submittable action type whose remote-mutation gate lives in the browser runtime, not the money policy (#243)", () => {
    expect(isActionType("browser.action")).toBe(true);
    // Under #243 the money predicate drives policy approval; browser.action is not money, so the policy
    // default no longer gates it. A side-effectful browser step (a click that submits/posts/purchases) is
    // still gated by the #174 runtime structural gate (`decideBrowserStep` → `needs_approval`), proven by
    // the browser-decide tests and the `storeBackedApprovalGate` suite above — that gate always parks.
    expect(DEFAULT_SENSITIVE_ACTIONS).not.toContain("browser.action");
    expect(evaluatePolicy({ actionType: "browser.action" }, []).requiresApproval).toBe(false);
  });

  it("validates its payload shape", () => {
    expect(validateBrowserAction({ sessionId: "s1", tool: "click", summary: "x" }).ok).toBe(true);
    expect(validateBrowserAction({ tool: "click", summary: "x" }).ok).toBe(false);
    expect(validateBrowserAction({ sessionId: "s1", tool: "click", summary: "x", target: 5 }).ok).toBe(false);
  });

  it("accepts a null target (a session-level action with no URL)", () => {
    expect(validateBrowserAction({ sessionId: "s1", tool: "click", summary: "x", target: null }).ok).toBe(true);
  });
});
