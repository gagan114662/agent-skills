/**
 * Worktree pool — PURE state machine (#343, ADR-0343). The treehouse model: a per-repo pool of
 * reusable, isolated git worktrees. Instead of creating a fresh checkout per session (slow — every
 * session loses installed deps + build cache), the fleet keeps a bounded pool of worktrees and hands
 * a session a clean-but-warm one (tracked files reset to base; gitignored `node_modules`/build cache
 * intact). This module is the decision core: no I/O, no git, no clock — every choice is a pure
 * function of the observed slot states, so it is exhaustively unit-testable and the {@link
 * ../worktree-pool/service.js WorktreePoolService} merely *executes* what it decides.
 *
 * Two invariants the decisions guarantee (premortem #200):
 *  - **Conflict-free**: a leased slot is never handed out again — concurrent acquirers each get a
 *    distinct slot (or `exhausted`), never the same one (#200 §3: never assume isolation).
 *  - **Reversibility**: a dirty slot is never auto-destroyed; {@link decideDestroy} refuses without an
 *    explicit `force` (the human/`--force` gate, #200 §4 — destroying uncommitted work is irreversible).
 */

/** A pooled worktree's lifecycle state. */
export type SlotState = "free" | "leased";

/** One pooled worktree. `dirty` reflects the last observed `git status` (uncommitted/untracked work). */
export interface PoolSlot {
  /** Stable pool-local id (e.g. `slot-0`) — derived by the service, never from client input. */
  readonly id: string;
  /** The worktree's working directory. */
  readonly path: string;
  /** `leased` while a session holds it; `free` once returned and reset. */
  readonly state: SlotState;
  /** True when the worktree has uncommitted tracked changes or untracked (non-ignored) files. */
  readonly dirty: boolean;
  /** The session currently holding the slot (only set when `leased`). */
  readonly leasedBy?: string;
}

/** Pool sizing — the hard cap on how many worktrees the pool may materialize. */
export interface PoolConfig {
  /** Max worktrees in the pool. The pool grows lazily up to this; `0` disables growth entirely. */
  readonly size: number;
}

/**
 * What {@link decideAcquire} resolves to. The service maps each kind to git work:
 *  - `reuse`           — the same session re-prepares; return its existing slot (idempotent, no git).
 *  - `lease`           — a free + clean slot is available; lease it as-is (the warm fast path).
 *  - `reset-then-lease`— a free but dirty slot is the best option; reset tracked files (deps kept) then lease.
 *  - `grow`            — no free slot but the pool is below `size`; create a new worktree and lease it.
 *  - `exhausted`       — every slot is leased and the pool is at `size`; the caller must wait / fall back.
 */
export type AcquireDecision =
  | { readonly kind: "reuse"; readonly slot: PoolSlot }
  | { readonly kind: "lease"; readonly slot: PoolSlot }
  | { readonly kind: "reset-then-lease"; readonly slot: PoolSlot }
  | { readonly kind: "grow"; readonly nextId: string }
  | { readonly kind: "exhausted" };

/**
 * Decide how to serve an acquire for `sessionId` given the currently observed `slots`. Pure and
 * deterministic. Preference order keeps the warm path cheapest and the pool conflict-free:
 *   1. a slot already leased to THIS session (re-prepare is idempotent),
 *   2. a free + clean slot (warm reuse — no reset),
 *   3. a free + dirty slot (reset tracked files, keep deps),
 *   4. grow if under `size`,
 *   5. otherwise exhausted.
 * A leased slot held by ANOTHER session is never selected, so two concurrent acquires can never be
 * handed the same worktree (#200 §3).
 */
export function decideAcquire(
  slots: readonly PoolSlot[],
  sessionId: string,
  cfg: PoolConfig,
): AcquireDecision {
  const mine = slots.find((s) => s.state === "leased" && s.leasedBy === sessionId);
  if (mine) return { kind: "reuse", slot: mine };

  const freeClean = slots.find((s) => s.state === "free" && !s.dirty);
  if (freeClean) return { kind: "lease", slot: freeClean };

  const freeDirty = slots.find((s) => s.state === "free" && s.dirty);
  if (freeDirty) return { kind: "reset-then-lease", slot: freeDirty };

  if (slots.length < cfg.size) return { kind: "grow", nextId: nextSlotId(slots) };

  return { kind: "exhausted" };
}

/** What {@link decideRelease} resolves to: which slot to return, or nothing if the session held none. */
export type ReleaseDecision =
  | { readonly kind: "release"; readonly slot: PoolSlot }
  | { readonly kind: "noop" };

/**
 * Decide the return of whatever slot `sessionId` holds. Returning resets tracked files to base and
 * marks the slot free (deps/build cache are gitignored, so they survive) — the warm-reuse primitive.
 * A session that holds no slot is a no-op (idempotent double-release is safe).
 */
export function decideRelease(slots: readonly PoolSlot[], sessionId: string): ReleaseDecision {
  const held = slots.find((s) => s.state === "leased" && s.leasedBy === sessionId);
  return held ? { kind: "release", slot: held } : { kind: "noop" };
}

/** What {@link decideDestroy} resolves to. `allowed:false` carries the human-readable refusal reason. */
export type DestroyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Gate the destruction of a slot (#200 §4 — irreversibility). Destroying a worktree with uncommitted
 * work is irreversible, so a **dirty** slot is refused unless `force` is set (the `--force`/human
 * gate). A clean slot is always destroyable; a leased-but-clean slot is allowed too (the caller is
 * choosing to evict it), but a dirty slot — leased or free — needs explicit force.
 */
export function decideDestroy(slot: PoolSlot, opts: { readonly force?: boolean } = {}): DestroyDecision {
  if (slot.dirty && !opts.force) {
    return {
      allowed: false,
      reason: `slot ${slot.id} has uncommitted changes — pass force to destroy (irreversible, #200 §4)`,
    };
  }
  return { allowed: true };
}

/**
 * Is a slot genuinely in use by a session this process is still driving? A lease whose session is no
 * longer in `activeSessionIds` is a stale lease (a crashed/finished run), NOT in use — so the reaper
 * may safely return it. Mirrors the #70 keep-set reaper: never reap a live concurrent run.
 */
export function isInUse(slot: PoolSlot, activeSessionIds: Iterable<string>): boolean {
  if (slot.state !== "leased" || slot.leasedBy === undefined) return false;
  const active = activeSessionIds instanceof Set ? activeSessionIds : new Set(activeSessionIds);
  return active.has(slot.leasedBy);
}

/**
 * The session ids whose leases are stale — leased slots whose holder is no longer active. The reaper
 * returns exactly these (resets + frees them) so a crashed session's warm worktree re-enters the
 * pool instead of leaking, while a live concurrent run is never touched (#200 §3).
 */
export function reapableLeases(
  slots: readonly PoolSlot[],
  activeSessionIds: Iterable<string>,
): string[] {
  const active = activeSessionIds instanceof Set ? activeSessionIds : new Set(activeSessionIds);
  const ids: string[] = [];
  for (const s of slots) {
    if (s.state === "leased" && s.leasedBy !== undefined && !active.has(s.leasedBy)) {
      ids.push(s.leasedBy);
    }
  }
  return ids;
}

/** The next free `slot-N` id given the existing slots (lowest unused index — stable, gap-filling). */
function nextSlotId(slots: readonly PoolSlot[]): string {
  const used = new Set(slots.map((s) => s.id));
  for (let i = 0; i < slots.length + 1; i++) {
    const id = `slot-${i}`;
    if (!used.has(id)) return id;
  }
  /* unreachable: the loop bound (length+1) guarantees a gap, but TS needs a return */
  return `slot-${slots.length}`;
}
