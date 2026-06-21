import { describe, it, expect } from "vitest";
import {
  wouldCreateCycle,
  isBlockerSatisfied,
  unsatisfiedBlockerCount,
} from "../../src/tasks/dependencies.js";

/**
 * Pure dependency logic (#515). The DAG guard (`wouldCreateCycle`) and the blocker-satisfaction
 * predicate are unit-tested without a database, the same way `tasks/status.ts` is — the DB
 * UNIQUE/CHECK constraints are the matching edge guards.
 */

describe("task dependency cycle detection (#515)", () => {
  // `dependsOn` adjacency: dependsOn[x] = the tasks x depends on (its blockers).
  it("rejects a self-dependency", () => {
    expect(wouldCreateCycle(new Map(), "a", "a")).toBe(true);
  });

  it("allows a fresh edge between unrelated tasks", () => {
    expect(wouldCreateCycle(new Map(), "a", "b")).toBe(false);
  });

  it("rejects a direct 2-cycle (b already depends on a)", () => {
    // b depends on a; adding 'a depends on b' would close the loop a→b→a.
    const dependsOn = new Map([["b", ["a"]]]);
    expect(wouldCreateCycle(dependsOn, "a", "b")).toBe(true);
  });

  it("rejects a transitive cycle (c→b→a, then a depends on c)", () => {
    // c depends on b, b depends on a. Adding 'a depends on c' closes a→c→b→a.
    const dependsOn = new Map([
      ["c", ["b"]],
      ["b", ["a"]],
    ]);
    expect(wouldCreateCycle(dependsOn, "a", "c")).toBe(true);
  });

  it("allows a diamond (shared blocker, still a DAG)", () => {
    // b depends on a, c depends on a. Adding 'd depends on b' AND later 'd depends on c' is fine.
    const dependsOn = new Map([
      ["b", ["a"]],
      ["c", ["a"]],
      ["d", ["b"]],
    ]);
    expect(wouldCreateCycle(dependsOn, "d", "c")).toBe(false);
  });
});

describe("blocker satisfaction (#515)", () => {
  it("a blocker is satisfied only once it is done or canceled", () => {
    expect(isBlockerSatisfied("done")).toBe(true);
    expect(isBlockerSatisfied("canceled")).toBe(true);
    expect(isBlockerSatisfied("backlog")).toBe(false);
    expect(isBlockerSatisfied("todo")).toBe(false);
    expect(isBlockerSatisfied("in_progress")).toBe(false);
    expect(isBlockerSatisfied("blocked")).toBe(false);
  });

  it("counts only the unsatisfied blockers", () => {
    expect(unsatisfiedBlockerCount([])).toBe(0);
    expect(unsatisfiedBlockerCount(["done", "canceled"])).toBe(0);
    expect(unsatisfiedBlockerCount(["done", "in_progress", "todo"])).toBe(2);
  });
});
