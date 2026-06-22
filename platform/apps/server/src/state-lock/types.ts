/**
 * Shared-state concurrency types (issue #639). The currency of the state-locking module: a versioned,
 * workspace-scoped record of a piece of shared state, plus the typed errors the serialized-write path
 * raises. The record carries an integer `version` that increments by exactly one on every committed write
 * — that monotonic counter is what lets the store do an optimistic compare-and-swap (detect a concurrent
 * writer) and what {@link module:state-lock/invariants} checks to prove no update was silently lost.
 *
 * Everything is keyed by `(workspaceId, key)` so a caller can only ever read or mutate its own tenant's
 * state — the #3 IDOR boundary, exactly like the sibling self-contained modules (#643/#670).
 */

/**
 * One piece of shared state. `value` is opaque to the module (the caller owns its shape); the module only
 * guarantees that writes to it are serialized and that `version` advances by one per commit.
 */
export interface SharedStateRecord<T = unknown> {
  /** Tenant boundary (#3 IDOR scoping). */
  workspaceId: string;
  /** Entity key, unique within a workspace — the unit of serialization. */
  key: string;
  /** Monotonic write counter: 1 at creation, +1 on every committed update. Drives the optimistic CAS. */
  version: number;
  /** The caller-owned state payload. */
  value: T;
  /** Epoch-ms of the last committed write. */
  updatedAtMs: number;
}

/** Input to seed a brand-new piece of shared state (version starts at 1). */
export interface CreateStateInput<T = unknown> {
  workspaceId: string;
  key: string;
  value: T;
}

/** Base class for all state-lock errors so callers can `catch` the family. */
export class StateLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateLockError";
  }
}

/** Raised when a piece of state expected to exist is missing. */
export class StateNotFoundError extends StateLockError {
  constructor(workspaceId: string, key: string) {
    super(`state-lock: no shared state ${workspaceId}/${key}`);
    this.name = "StateNotFoundError";
  }
}

/** Raised when state expected to be new already exists (a duplicate create). */
export class StateExistsError extends StateLockError {
  constructor(workspaceId: string, key: string) {
    super(`state-lock: shared state ${workspaceId}/${key} already exists`);
    this.name = "StateExistsError";
  }
}

/**
 * Raised when an update could not commit within the retry budget because a concurrent writer kept winning
 * the compare-and-swap. Distinct from {@link InvariantViolationError}: a conflict means *contention*, not
 * *corruption* — the state is still consistent, the caller just lost every race and should retry later.
 */
export class StateConflictError extends StateLockError {
  constructor(
    workspaceId: string,
    key: string,
    readonly attempts: number,
  ) {
    super(`state-lock: lost CAS on ${workspaceId}/${key} after ${attempts} attempt(s)`);
    this.name = "StateConflictError";
  }
}

/**
 * Raised when an invariant is violated — i.e. corruption was *detected* (a non-monotonic version, a key or
 * workspace that changed under a write, a non-integer counter). This should never happen on a correctly
 * serialized path; if it fires, the serialization itself failed and the write is refused rather than
 * committed, so corruption is surfaced loudly instead of persisted silently.
 */
export class InvariantViolationError extends StateLockError {
  constructor(message: string) {
    super(`state-lock: invariant violated: ${message}`);
    this.name = "InvariantViolationError";
  }
}
