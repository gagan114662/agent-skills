import { describe, it, expect } from "vitest";
import { buildDefaultRegistry } from "../../src/approvals/runtime.js";
import { validateAgentDeliverable } from "../../src/approvals/executor.js";
import { evaluatePolicy, isMoneyAction } from "../../src/approvals/policy.js";

/**
 * #248: a completed agent session's draft is surfaced as a pending `agent.deliverable` review card so a
 * briefed task never "vanishes". The card must (a) NOT be a money action (#243 money-only gating stays
 * intact — it requires no money approval and creates no new authority), and (b) approve cleanly via a
 * no-op acknowledgement executor (never "no executor for agent.deliverable").
 */
describe("agent.deliverable review card (#248)", () => {
  it("is NOT a money action and is not auto-gated (so #243 money-only is intact)", () => {
    expect(isMoneyAction("agent.deliverable")).toBe(false);
    // With no workspace rule, a non-money action runs without an owner gate.
    expect(evaluatePolicy({ actionType: "agent.deliverable" }, []).requiresApproval).toBe(false);
  });

  it("validates the payload (sessionId required; draft/task optional)", () => {
    expect(validateAgentDeliverable({ sessionId: "s1", draft: "x" }).ok).toBe(true);
    expect(validateAgentDeliverable({ sessionId: "s1" }).ok).toBe(true); // optional fields may be absent
    expect(validateAgentDeliverable({ draft: "x" }).ok).toBe(false);
    expect(validateAgentDeliverable(null).ok).toBe(false);
  });

  it("rejects malformed optional fields so bad data never reaches the DB/UI (gemini #249)", () => {
    expect(validateAgentDeliverable({ sessionId: "s1", draft: 42 }).ok).toBe(false);
    expect(validateAgentDeliverable({ sessionId: "s1", task: { a: 1 } }).ok).toBe(false);
    expect(validateAgentDeliverable({ sessionId: "s1", channelId: 7 }).ok).toBe(false);
    // a well-typed full payload still passes
    expect(
      validateAgentDeliverable({ sessionId: "s1", draft: "d", task: "t", channelId: "c1" }).ok,
    ).toBe(true);
  });

  it("acknowledges on approval — a clean ok:true with NO side effect (publishing stays autonomous)", async () => {
    const exec = buildDefaultRegistry().get("agent.deliverable")!;
    expect(exec).toBeDefined();
    const result = await exec.execute(
      { sessionId: "019ecc61-19eb-75c2-b07d-892c633ab05c", draft: "Here's a draft" },
      { workspaceId: "ws1", requesterMemberId: "m1" } as never,
    );
    expect(result).toMatchObject({ acknowledged: true });
    expect(result.sessionId).toBe("019ecc61-19eb-75c2-b07d-892c633ab05c");
  });
});
