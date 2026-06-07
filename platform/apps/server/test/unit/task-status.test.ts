import { describe, it, expect } from "vitest";
import { STATUSES, canTransition, isStatus } from "../../src/tasks/status.js";

describe("task status lifecycle (#14)", () => {
  it("exposes the six lifecycle statuses", () => {
    expect([...STATUSES]).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "blocked",
      "done",
      "canceled",
    ]);
  });

  it("isStatus narrows valid values and rejects junk", () => {
    expect(isStatus("in_progress")).toBe(true);
    expect(isStatus("review")).toBe(false);
    expect(isStatus("")).toBe(false);
  });

  it("allows the forward path backlog → todo → in_progress → done", () => {
    expect(canTransition("backlog", "todo")).toBe(true);
    expect(canTransition("todo", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "done")).toBe(true);
  });

  it("allows blocking and unblocking", () => {
    expect(canTransition("in_progress", "blocked")).toBe(true);
    expect(canTransition("blocked", "in_progress")).toBe(true);
  });

  it("allows reopening a terminal task to todo", () => {
    expect(canTransition("done", "todo")).toBe(true);
    expect(canTransition("canceled", "todo")).toBe(true);
  });

  it("rejects a no-op (same-status) transition", () => {
    expect(canTransition("todo", "todo")).toBe(false);
    expect(canTransition("done", "done")).toBe(false);
  });

  it("rejects skipping the lifecycle or moving out of a terminal state", () => {
    expect(canTransition("backlog", "done")).toBe(false);
    expect(canTransition("done", "in_progress")).toBe(false);
    expect(canTransition("blocked", "done")).toBe(false);
    expect(canTransition("canceled", "done")).toBe(false);
  });
});
