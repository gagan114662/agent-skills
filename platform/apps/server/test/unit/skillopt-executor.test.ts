import { describe, it, expect } from "vitest";
import { buildDefaultRegistry } from "../../src/approvals/runtime.js";
import { SKILLOPT_ADOPT_EDIT_ACTION, isMoneyAction } from "../../src/approvals/policy.js";

/**
 * #283 — the `skillopt.adopt_skill_edit` executor wiring. Adopting an agent skill edit is a behavior-altering,
 * owner-only decision: NOT a money action, recorded-only on approval (applying the edit to the versioned
 * skill doc is a deliberate follow-up — the executor writes no file and makes no network call).
 */
describe("skillopt.adopt_skill_edit executor (#283)", () => {
  const exec = buildDefaultRegistry().get(SKILLOPT_ADOPT_EDIT_ACTION)!;
  const ctx = { workspaceId: "ws1", requesterMemberId: "m1" } as never;

  it("is registered in the default registry", () => {
    expect(exec).toBeDefined();
    expect(exec.actionType).toBe("skillopt.adopt_skill_edit");
  });

  it("is NOT a money action (no payment, no spend)", () => {
    expect(isMoneyAction(SKILLOPT_ADOPT_EDIT_ACTION)).toBe(false);
  });

  it("validates a complete payload and rejects an incomplete one", () => {
    expect(
      exec.validate({ handle: "scout", skillId: "scout/runbook", currentDocSha: "sha-1", appendText: "x" }),
    ).toEqual({ ok: true });
    expect(exec.validate({ handle: "scout", skillId: "scout/runbook" }).ok).toBe(false);
    expect(exec.validate({}).ok).toBe(false);
  });

  it("summarizes the proposal for the review card", () => {
    const s = exec.summarize({ handle: "scout", skillId: "scout/runbook", appendText: "Homepage audit shortcut" });
    expect(s).toContain("scout");
    expect(s).toContain("Homepage audit shortcut");
  });

  it("is recorded-only on approval (executed:false, no file/network)", async () => {
    const result = await exec.execute(
      { handle: "scout", skillId: "scout/runbook", currentDocSha: "sha-1", appendText: "x" },
      ctx,
    );
    expect(result.recorded).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.handle).toBe("scout");
    expect(result.currentDocSha).toBe("sha-1");
  });
});
