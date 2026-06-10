import { describe, it, expect } from "vitest";
import { diffCounts, assessFreshness, checksumsMatch } from "../../src/dr/verify.js";

describe("diffCounts", () => {
  it("returns no mismatches when actual meets expected exactly", () => {
    expect(diffCounts({ workspaces: 3, members: 5 }, { workspaces: 3, members: 5 })).toEqual([]);
  });

  it("flags a table whose restored count is short (truncation/partial restore)", () => {
    const m = diffCounts({ workspaces: 3, members: 5 }, { workspaces: 3, members: 2 });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ table: "members", expected: 5, actual: 2 });
  });

  it("flags a table missing entirely from the restore", () => {
    const m = diffCounts({ workspaces: 3 }, {});
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ table: "workspaces", expected: 3, actual: 0 });
  });
});

describe("assessFreshness", () => {
  const now = new Date("2026-06-10T12:00:00.000Z");

  it("is fresh when the newest row is within the bound", () => {
    const r = assessFreshness(new Date("2026-06-10T11:59:00.000Z"), now, 3_600_000);
    expect(r.fresh).toBe(true);
    expect(r.ageMs).toBe(60_000);
  });

  it("is stale when the newest row is older than the bound", () => {
    const r = assessFreshness(new Date("2026-06-10T10:00:00.000Z"), now, 3_600_000);
    expect(r.fresh).toBe(false);
  });

  it("treats an empty table (no newest row) as not fresh", () => {
    expect(assessFreshness(null, now, 3_600_000)).toEqual({ fresh: false, ageMs: null });
  });
});

describe("checksumsMatch", () => {
  it("returns no mismatches for identical checksums", () => {
    expect(checksumsMatch({ workspaces: "abc" }, { workspaces: "abc" })).toEqual([]);
  });

  it("flags a table whose content checksum differs (silent corruption a count would miss)", () => {
    const m = checksumsMatch({ workspaces: "abc", members: "d1" }, { workspaces: "abc", members: "d2" });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ table: "members" });
  });
});
