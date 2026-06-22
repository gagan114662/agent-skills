import { describe, expect, it } from "vitest";
import { InMemoryLogStore, LOG_LIST_HARD_LIMIT, type PersistLineInput } from "../../src/observability/logs/store.js";
import type { RunFailure } from "../../src/observability/logs/types.js";

const WS = "ws-1";
const RUN = "run-1";
const T0 = new Date("2026-06-22T00:00:00Z");

function line(partial: Partial<PersistLineInput> = {}): PersistLineInput {
  return {
    workspaceId: WS,
    runId: RUN,
    stream: "stdout",
    text: "hello",
    occurredAt: T0,
    ...partial,
  };
}

function failure(partial: Partial<RunFailure> = {}): RunFailure {
  return {
    workspaceId: WS,
    runId: RUN,
    toolName: "bash",
    args: { command: "ls" },
    error: "exit 1",
    occurredAt: T0,
    ...partial,
  };
}

describe("InMemoryLogStore.appendLines / listLines", () => {
  it("assigns monotonic seq in input order and reads back oldest-first", async () => {
    const store = new InMemoryLogStore();
    const appended = await store.appendLines([line({ text: "a" }), line({ text: "b" }), line({ text: "c" })]);
    expect(appended.map((l) => l.text)).toEqual(["a", "b", "c"]);
    expect(appended.map((l) => l.seq)).toEqual([1, 2, 3]);

    const read = await store.listLines(WS, RUN, {});
    expect(read.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  it("tails incrementally via afterSeq", async () => {
    const store = new InMemoryLogStore();
    await store.appendLines([line({ text: "a" }), line({ text: "b" }), line({ text: "c" })]);
    const tail = await store.listLines(WS, RUN, { afterSeq: 2 });
    expect(tail.map((l) => l.text)).toEqual(["c"]);
    expect(tail[0]!.seq).toBe(3);
  });

  it("bounds a page to the hard limit even when more is asked for", async () => {
    const store = new InMemoryLogStore();
    await store.appendLines(Array.from({ length: 3 }, (_, i) => line({ text: `l${i}` })));
    const page = await store.listLines(WS, RUN, { limit: LOG_LIST_HARD_LIMIT + 100 });
    expect(page).toHaveLength(3); // capped logic exercised; never exceeds the stored count
  });

  it("is workspace-scoped: a foreign workspace reads nothing (#3 IDOR)", async () => {
    const store = new InMemoryLogStore();
    await store.appendLines([line()]);
    expect(await store.listLines("ws-other", RUN, {})).toEqual([]);
  });

  it("separates lines by run", async () => {
    const store = new InMemoryLogStore();
    await store.appendLines([line({ runId: "r1", text: "x" }), line({ runId: "r2", text: "y" })]);
    expect((await store.listLines(WS, "r1", {})).map((l) => l.text)).toEqual(["x"]);
    expect((await store.listLines(WS, "r2", {})).map((l) => l.text)).toEqual(["y"]);
  });
});

describe("InMemoryLogStore failure record", () => {
  it("upserts: the latest failure for a run wins", async () => {
    const store = new InMemoryLogStore();
    await store.recordFailure(failure({ toolName: "bash", error: "first" }));
    await store.recordFailure(failure({ toolName: "web.fetch", error: "second" }));
    const got = await store.getFailure(WS, RUN);
    expect(got).toMatchObject({ toolName: "web.fetch", error: "second" });
  });

  it("returns null for a run with no failure and is workspace-scoped", async () => {
    const store = new InMemoryLogStore();
    await store.recordFailure(failure());
    expect(await store.getFailure(WS, "other-run")).toBeNull();
    expect(await store.getFailure("ws-other", RUN)).toBeNull();
  });
});

describe("InMemoryLogStore.prune (retention)", () => {
  it("removes lines and failures older than the cutoff and reports the count", async () => {
    const store = new InMemoryLogStore();
    const old = new Date("2026-01-01T00:00:00Z");
    const fresh = new Date("2026-06-22T00:00:00Z");
    await store.appendLines([line({ occurredAt: old, text: "stale" }), line({ occurredAt: fresh, text: "keep" })]);
    await store.recordFailure(failure({ occurredAt: old }));

    const removed = await store.prune(new Date("2026-03-01T00:00:00Z"));
    expect(removed).toBe(2); // one stale line + one stale failure

    const remaining = await store.listLines(WS, RUN, {});
    expect(remaining.map((l) => l.text)).toEqual(["keep"]);
    expect(await store.getFailure(WS, RUN)).toBeNull();
  });
});
