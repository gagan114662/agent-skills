import { describe, it, expect } from "vitest";
import { buildDefaultRegistry } from "../../src/approvals/runtime.js";
import {
  SKILLOPT_ADOPT_EDIT_ACTION,
  SKILLOPT_REVERT_EDIT_ACTION,
  isMoneyAction,
} from "../../src/approvals/policy.js";
import type { SkillOptApplier } from "../../src/approvals/runtime.js";

/**
 * #283 — the `skillopt.adopt_skill_edit` executor wiring. Adopting an agent skill edit is a behavior-altering,
 * owner-only decision: NOT a money action, recorded-only on approval (applying the edit to the versioned
 * skill doc is a deliberate follow-up — the executor writes no file and makes no network call).
 */
describe("skillopt.adopt_skill_edit executor (#283)", () => {
  const applied: unknown[] = [];
  const reverted: unknown[] = [];
  const fakeApplier: SkillOptApplier = {
    apply: async (input) => {
      applied.push(input);
      return { executed: true, adoptionId: "skillopt-r1", revertPayload: { skillId: input.skillId, adoptionId: "skillopt-r1" } };
    },
    revert: async (input) => {
      reverted.push(input);
      return { executed: true, adoptionId: input.adoptionId };
    },
  };
  const registry = buildDefaultRegistry(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fakeApplier,
  );
  const exec = registry.get(SKILLOPT_ADOPT_EDIT_ACTION)!;
  const revert = registry.get(SKILLOPT_REVERT_EDIT_ACTION)!;
  const ctx = { workspaceId: "ws1", requesterMemberId: "m1" } as never;

  it("is registered in the default registry", () => {
    expect(exec).toBeDefined();
    expect(exec.actionType).toBe("skillopt.adopt_skill_edit");
    expect(revert).toBeDefined();
    expect(revert.actionType).toBe("skillopt.revert_skill_edit");
  });

  it("is NOT a money action (no payment, no spend)", () => {
    expect(isMoneyAction(SKILLOPT_ADOPT_EDIT_ACTION)).toBe(false);
    expect(isMoneyAction(SKILLOPT_REVERT_EDIT_ACTION)).toBe(false);
  });

  it("validates a complete payload and rejects an incomplete one", () => {
    expect(
      exec.validate({ handle: "scout", skillId: "scout/runbook", currentDocSha: "sha-1", appendText: "x" }),
    ).toEqual({ ok: true });
    expect(exec.validate({ handle: "scout", skillId: "scout/runbook" }).ok).toBe(false);
    expect(exec.validate({}).ok).toBe(false);
    expect(revert.validate({ skillId: "scout/runbook", adoptionId: "skillopt-r1" })).toEqual({ ok: true });
    expect(revert.validate({ skillId: "scout/runbook" }).ok).toBe(false);
  });

  it("summarizes the proposal for the review card", () => {
    const s = exec.summarize({ handle: "scout", skillId: "scout/runbook", appendText: "Homepage audit shortcut" });
    expect(s).toContain("scout");
    expect(s).toContain("Homepage audit shortcut");
  });

  it("applies through the injected versioned-doc applier and returns a one-click revert payload", async () => {
    const result = await exec.execute(
      { handle: "scout", skillId: "scout/runbook", currentDocSha: "sha-1", appendText: "x" },
      { ...ctx, requestId: "r1" },
    );
    expect(result.executed).toBe(true);
    expect(result.revertPayload).toEqual({ skillId: "scout/runbook", adoptionId: "skillopt-r1" });
    expect(applied).toEqual([
      { handle: "scout", skillId: "scout/runbook", currentDocSha: "sha-1", appendText: "x", requestId: "r1" },
    ]);
  });

  it("reverts through the injected applier", async () => {
    const result = await revert.execute({ skillId: "scout/runbook", adoptionId: "skillopt-r1" }, ctx);
    expect(result.executed).toBe(true);
    expect(reverted).toEqual([{ skillId: "scout/runbook", adoptionId: "skillopt-r1" }]);
  });
});
