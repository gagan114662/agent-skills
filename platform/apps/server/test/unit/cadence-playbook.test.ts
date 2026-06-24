import { describe, it, expect } from "vitest";
import {
  CADENCE_PLAYBOOK,
  CADENCE_PLAYBOOK_LENGTH,
  nextTaskIndex,
  selectTaskIndexFromOutcomes,
  taskAt,
} from "../../src/cadence/playbook.js";

/**
 * #416 — the dogfood-growth playbook is a pure, cyclic, DRAFT-ONLY backlog. The round-robin wraps, every
 * goal stays draft-only (no send/publish/spend verb), and indices normalize so the engine can never index
 * out of range.
 */
describe("cadence playbook (#416)", () => {
  it("is non-empty and every task targets a fleet lead with a concrete goal", () => {
    expect(CADENCE_PLAYBOOK_LENGTH).toBeGreaterThan(0);
    expect(CADENCE_PLAYBOOK.length).toBe(CADENCE_PLAYBOOK_LENGTH);
    for (const t of CADENCE_PLAYBOOK) {
      expect(t.lead).toMatch(/^[a-z]+$/); // a bare @handle, no leading @
      expect(t.outcomeKey).toMatch(/^[a-z]+$/);
      expect(t.goal.trim().length).toBeGreaterThan(20);
    }
  });

  it("nextTaskIndex round-robins and WRAPS at the end", () => {
    const len = CADENCE_PLAYBOOK_LENGTH;
    let cursor = 0;
    const visited: number[] = [];
    for (let i = 0; i < len; i++) {
      visited.push(cursor);
      cursor = nextTaskIndex(cursor, len);
    }
    // Visited every index exactly once, in order, and wrapped back to 0.
    expect(visited).toEqual(Array.from({ length: len }, (_, i) => i));
    expect(cursor).toBe(0);
  });

  it("nextTaskIndex normalizes a non-positive length and an out-of-range cursor", () => {
    expect(nextTaskIndex(5, 0)).toBe(0);
    expect(nextTaskIndex(-1, 0)).toBe(0);
    // A cursor outside [0,len) is normalized before advancing.
    expect(nextTaskIndex(CADENCE_PLAYBOOK_LENGTH, CADENCE_PLAYBOOK_LENGTH)).toBe(1);
    expect(nextTaskIndex(-1, CADENCE_PLAYBOOK_LENGTH)).toBe(0);
  });

  it("taskAt wraps over the cyclic playbook", () => {
    expect(taskAt(0)).toEqual(CADENCE_PLAYBOOK[0]);
    expect(taskAt(CADENCE_PLAYBOOK_LENGTH)).toEqual(CADENCE_PLAYBOOK[0]); // wrap
    expect(taskAt(-1)).toEqual(CADENCE_PLAYBOOK[CADENCE_PLAYBOOK_LENGTH - 1]);
  });

  it("NO playbook goal contains a send/publish/spend verb — draft-only is enforced", () => {
    // Outbound verbs as whole words. A future edit that smuggles one in fails this test, not prod.
    const OUTBOUND = /\b(send|sends|sent|publish|publishes|published|post(s|ed)? to|spend|spends|spent|launch the ad|go live)\b/i;
    for (const t of CADENCE_PLAYBOOK) {
      // "nothing posts" / "no spend" are explicit NEGATIVES — assert the goal explicitly forbids outbound
      // rather than commanding it. We check the goal does not COMMAND an outbound action.
      const commandsOutbound = /\b(send|publish|spend)\s+(it|the|this|out|them)\b/i.test(t.goal);
      expect(commandsOutbound, `goal commands an outbound action: ${t.goal}`).toBe(false);
      // And it must contain a draft-only signal word.
      expect(t.goal).toMatch(/\b(draft|drafts|audit|summari[sz]e|review|notes|findings|list)\b/i);
      // Belt: it should not literally say "publish the post" / "send the email" / "spend $".
      expect(OUTBOUND.test(t.goal) && !/\b(no|nothing|never|without|don't|do not)\b/i.test(t.goal)).toBe(false);
    }
  });

  it("selectTaskIndexFromOutcomes doubles down on the strongest verified winner", () => {
    const selected = selectTaskIndexFromOutcomes(0, [
      { outcomeKey: "seo", result: "worked", conversions: 1 },
      { outcomeKey: "social", result: "worked", conversions: 3 },
    ]);
    expect(CADENCE_PLAYBOOK[selected]?.lead).toBe("echo");
  });

  it("selectTaskIndexFromOutcomes repairs a failed bucket when nothing worked", () => {
    const selected = selectTaskIndexFromOutcomes(1, [{ outcomeKey: "seo", result: "failed" }]);
    expect(CADENCE_PLAYBOOK[selected]?.lead).toBe("scout");
  });

  it("selectTaskIndexFromOutcomes preserves round-robin when no matching outcome exists", () => {
    expect(selectTaskIndexFromOutcomes(2, [])).toBe(2);
    expect(selectTaskIndexFromOutcomes(2, [{ outcomeKey: "unknown", result: "worked" }])).toBe(2);
  });
});
