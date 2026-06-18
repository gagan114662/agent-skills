import { describe, it, expect } from "vitest";
import { InMemoryDurableRunStore } from "../../src/durable-workflow/store.js";

function newRunInput(over: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-1",
    workflowKey: "k",
    idempotencyKey: "job-1",
    deadlineAtMs: 100_000,
    requiresApproval: false,
    approvalRequestId: null,
    state: { tries: 0 },
    nowMs: 1_000,
    ...over,
  };
}

describe("InMemoryDurableRunStore", () => {
  it("findOrCreate is idempotent per (workspace, idempotencyKey) — resumes, never forks", async () => {
    const store = new InMemoryDurableRunStore();
    const a = await store.findOrCreate(newRunInput());
    const b = await store.findOrCreate(newRunInput());
    expect(b.id).toBe(a.id);

    // A different workspace with the same key is a DIFFERENT run (tenant isolation, #3).
    const other = await store.findOrCreate(newRunInput({ workspaceId: "ws-2" }));
    expect(other.id).not.toBe(a.id);
  });

  it("persists a saved record and returns an isolated copy (no mutation by reference)", async () => {
    const store = new InMemoryDurableRunStore();
    const rec = await store.findOrCreate(newRunInput());
    const saved = await store.save({ ...rec, status: "succeeded", result: "X" });
    expect(saved.status).toBe("succeeded");

    // Mutating the returned object must not corrupt the stored row.
    saved.result = "TAMPERED";
    const reread = await store.get(rec.id);
    expect(reread?.result).toBe("X");
  });

  it("listDue returns only non-terminal, non-parked runs whose backoff cursor has elapsed", async () => {
    const store = new InMemoryDurableRunStore();
    await store.findOrCreate(newRunInput({ idempotencyKey: "running" })); // stays `running`, no cursor → due
    const suspendedDue = await store.findOrCreate(newRunInput({ idempotencyKey: "due" }));
    const suspendedFuture = await store.findOrCreate(newRunInput({ idempotencyKey: "future" }));
    const parked = await store.findOrCreate(newRunInput({ idempotencyKey: "parked" }));
    const succeeded = await store.findOrCreate(newRunInput({ idempotencyKey: "done" }));

    await store.save({ ...suspendedDue, status: "suspended", nextAttemptAtMs: 2_000 });
    await store.save({ ...suspendedFuture, status: "suspended", nextAttemptAtMs: 9_000 });
    await store.save({ ...parked, status: "waiting_approval" });
    await store.save({ ...succeeded, status: "succeeded" });

    const due = await store.listDue("ws-1", 5_000);
    const ids = due.map((r) => r.idempotencyKey).sort();
    expect(ids).toEqual(["due", "running"]); // running (no cursor) + the elapsed suspended one
    expect(ids).not.toContain("future"); // cursor not yet elapsed
    expect(ids).not.toContain("parked"); // waiting on a human
    expect(ids).not.toContain("done"); // terminal
  });
});
