import { describe, it, expect } from "vitest";
import {
  decideAcquire,
  decideDestroy,
  decideRelease,
  isInUse,
  reapableLeases,
  type PoolSlot,
} from "../../src/worktree-pool/pool.js";
import {
  isWorktreePoolEnabledForWorkspace,
  resolveWorktreePoolCaps,
  WORKTREE_POOL_DEFAULTS,
} from "../../src/worktree-pool/caps.js";

/**
 * Pure worktree-pool decision core (#343, ADR-0343). No git, no I/O — proves the two invariants the
 * service relies on: conflict-free acquire (never the same slot twice) and reversibility (never
 * auto-destroy a dirty worktree without force, premortem #200 §4).
 */

const slot = (over: Partial<PoolSlot> & Pick<PoolSlot, "id">): PoolSlot => ({
  path: `/pool/${over.id}`,
  state: "free",
  dirty: false,
  ...over,
});

describe("decideAcquire", () => {
  const cfg = { size: 3 };

  it("grows from an empty pool", () => {
    expect(decideAcquire([], "s1", cfg)).toEqual({ kind: "grow", nextId: "slot-0" });
  });

  it("reuses a free + clean slot warm (no reset)", () => {
    const d = decideAcquire([slot({ id: "slot-0" })], "s1", cfg);
    expect(d).toEqual({ kind: "lease", slot: slot({ id: "slot-0" }) });
  });

  it("prefers a clean free slot over a dirty free slot", () => {
    const slots = [slot({ id: "slot-0", dirty: true }), slot({ id: "slot-1", dirty: false })];
    const d = decideAcquire(slots, "s1", cfg);
    expect(d.kind).toBe("lease");
    expect(d.kind === "lease" && d.slot.id).toBe("slot-1");
  });

  it("resets a free dirty slot when it is the only free option", () => {
    const d = decideAcquire([slot({ id: "slot-0", dirty: true })], "s1", cfg);
    expect(d.kind).toBe("reset-then-lease");
    expect(d.kind === "reset-then-lease" && d.slot.id).toBe("slot-0");
  });

  it("is idempotent for a session that already holds a slot (reuse, not a second lease)", () => {
    const slots = [slot({ id: "slot-0", state: "leased", leasedBy: "s1" }), slot({ id: "slot-1" })];
    const d = decideAcquire(slots, "s1", cfg);
    expect(d.kind).toBe("reuse");
    expect(d.kind === "reuse" && d.slot.id).toBe("slot-0");
  });

  it("never hands out a slot leased by another session (conflict-free)", () => {
    // one slot, leased by s1; s2 must grow, never get slot-0
    const slots = [slot({ id: "slot-0", state: "leased", leasedBy: "s1" })];
    const d = decideAcquire(slots, "s2", { size: 3 });
    expect(d).toEqual({ kind: "grow", nextId: "slot-1" });
  });

  it("returns exhausted when every slot is leased and the pool is at cap", () => {
    const slots = [
      slot({ id: "slot-0", state: "leased", leasedBy: "s1" }),
      slot({ id: "slot-1", state: "leased", leasedBy: "s2" }),
    ];
    expect(decideAcquire(slots, "s3", { size: 2 })).toEqual({ kind: "exhausted" });
  });

  it("fills the lowest free slot-id gap when growing", () => {
    const slots = [slot({ id: "slot-0", state: "leased", leasedBy: "s1" })];
    const d = decideAcquire(slots, "s2", { size: 5 });
    expect(d).toEqual({ kind: "grow", nextId: "slot-1" });
  });
});

describe("decideRelease", () => {
  it("releases the slot the session holds", () => {
    const slots = [slot({ id: "slot-0", state: "leased", leasedBy: "s1" })];
    const d = decideRelease(slots, "s1");
    expect(d.kind).toBe("release");
    expect(d.kind === "release" && d.slot.id).toBe("slot-0");
  });

  it("is a no-op for a session holding nothing (idempotent double-release)", () => {
    expect(decideRelease([slot({ id: "slot-0" })], "ghost")).toEqual({ kind: "noop" });
  });
});

describe("decideDestroy — reversibility gate (#200 §4)", () => {
  it("allows destroying a clean slot", () => {
    expect(decideDestroy(slot({ id: "slot-0", dirty: false }))).toEqual({ allowed: true });
  });

  it("REFUSES destroying a dirty slot without force", () => {
    const d = decideDestroy(slot({ id: "slot-0", dirty: true }));
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toMatch(/uncommitted/);
  });

  it("allows destroying a dirty slot WITH force (the human/--force gate)", () => {
    expect(decideDestroy(slot({ id: "slot-0", dirty: true }), { force: true })).toEqual({ allowed: true });
  });
});

describe("in-use detection", () => {
  it("a lease held by an active session is in use", () => {
    expect(isInUse(slot({ id: "slot-0", state: "leased", leasedBy: "s1" }), ["s1"])).toBe(true);
  });

  it("a lease whose session is gone is NOT in use (a stale lease)", () => {
    expect(isInUse(slot({ id: "slot-0", state: "leased", leasedBy: "s1" }), ["s2"])).toBe(false);
  });

  it("a free slot is never in use", () => {
    expect(isInUse(slot({ id: "slot-0" }), ["s1"])).toBe(false);
  });

  it("reapableLeases returns only stale leases, never a live concurrent run", () => {
    const slots = [
      slot({ id: "slot-0", state: "leased", leasedBy: "live" }),
      slot({ id: "slot-1", state: "leased", leasedBy: "crashed" }),
      slot({ id: "slot-2", state: "free" }),
    ];
    expect(reapableLeases(slots, ["live"])).toEqual(["crashed"]);
  });
});

describe("caps — default OFF, owner-workspace-first", () => {
  it("defaults: disabled, owner-first, size 4", () => {
    expect(resolveWorktreePoolCaps(undefined)).toEqual(WORKTREE_POOL_DEFAULTS);
    expect(WORKTREE_POOL_DEFAULTS.enabled).toBe(false);
  });

  it("disabled config pools nobody", () => {
    const caps = resolveWorktreePoolCaps({});
    expect(isWorktreePoolEnabledForWorkspace(caps, "ws_owner")).toBe(false);
  });

  it("enabled without an owner id pools nobody (safest default)", () => {
    const caps = resolveWorktreePoolCaps({ enabled: true });
    expect(isWorktreePoolEnabledForWorkspace(caps, "ws_owner")).toBe(false);
  });

  it("enabled + owner id pools ONLY the owner workspace", () => {
    const caps = resolveWorktreePoolCaps({ enabled: true, ownerWorkspaceId: "ws_owner" });
    expect(isWorktreePoolEnabledForWorkspace(caps, "ws_owner")).toBe(true);
    expect(isWorktreePoolEnabledForWorkspace(caps, "ws_other")).toBe(false);
  });

  it("ownerWorkspaceOnly:false pools everyone once proven", () => {
    const caps = resolveWorktreePoolCaps({ enabled: true, ownerWorkspaceOnly: false });
    expect(isWorktreePoolEnabledForWorkspace(caps, "anyone")).toBe(true);
  });

  it("size 0 pools nobody even when enabled", () => {
    const caps = resolveWorktreePoolCaps({ enabled: true, ownerWorkspaceOnly: false, size: 0 });
    expect(isWorktreePoolEnabledForWorkspace(caps, "anyone")).toBe(false);
  });
});
