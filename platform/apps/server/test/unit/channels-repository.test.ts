import { beforeEach, describe, expect, it, vi } from "vitest";

const existing = { id: "dm-existing", workspaceId: "ws-1", kind: "dm", name: null };
let selectResult: unknown[] = [existing];

const limit = vi.fn(async () => selectResult);
const where = vi.fn(() => ({ limit }));
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));
const returning = vi.fn(async () => [{ id: "dm-created", workspaceId: "ws-1", kind: "dm", name: null }]);
const values = vi.fn(() => ({ returning }));
const insert = vi.fn(() => ({ values }));
const transaction = vi.fn(async (fn: (tx: { select: typeof select; insert: typeof insert }) => Promise<unknown>) =>
  fn({ select, insert }),
);

vi.mock("../../src/db/index.js", () => ({
  db: { transaction },
}));

const { getOrCreateDm } = await import("../../src/db/repositories/channels.js");

beforeEach(() => {
  selectResult = [existing];
  vi.clearAllMocks();
});

describe("getOrCreateDm bounded lookup", () => {
  it("uses one bounded lookup query for an existing exact member set", async () => {
    const dm = await getOrCreateDm("ws-1", ["b", "a", "a"]);

    expect(dm).toBe(existing);
    expect(select).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it("bulk-inserts the bounded member set when no exact DM exists", async () => {
    selectResult = [];

    await getOrCreateDm("ws-1", ["b", "a", "a"]);

    expect(select).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenLastCalledWith([
      { channelId: "dm-created", memberId: "a" },
      { channelId: "dm-created", memberId: "b" },
    ]);
  });
});
