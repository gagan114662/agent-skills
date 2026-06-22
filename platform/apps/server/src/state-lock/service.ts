/**
 * Serialized shared-state writer (issue #639). The IO shell that composes the three halves of the fix into
 * one safe `update`:
 *
 *   1. **In-process serialization** — every read-modify-write for an entity runs inside a per-key
 *      {@link KeyedMutex} section, so two coroutines in *this* replica can never interleave their awaits
 *      and clobber each other. (See {@link module:state-lock/mutex}.)
 *   2. **Cross-process optimistic concurrency** — the write commits via the store's compare-and-swap,
 *      which only applies if the stored version still matches the one read. A writer in *another* replica
 *      that committed in between makes the CAS miss; the service then re-reads and re-runs the mutator,
 *      up to a bounded retry budget. A lost update is therefore impossible — contention only costs retries.
 *   3. **Invariant enforcement** — every transition is checked ({@link assertTransition}) *before* it is
 *      offered to the store, so a malformed write (version that didn't advance by one, identity that
 *      changed) is refused loudly rather than persisted as corruption.
 *
 * The mutator is a pure `(current) => next` function over the state *value*; the service owns versioning,
 * timestamps, and identity, so a mutator cannot accidentally corrupt them. All time comes from the
 * injected `now()` and all persistence from the injected store, so the service is unit-tested with no
 * clock and no DB — including the N-concurrent-writer stress test that is the issue's acceptance gate.
 */

import { KeyedMutex } from "./mutex.js";
import { assertRecord, assertTransition } from "./invariants.js";
import type { SharedStateStore } from "./store.js";
import { resolveStateLockCaps, type StateLockCaps } from "./caps.js";
import {
  StateConflictError,
  StateLockError,
  StateNotFoundError,
  type SharedStateRecord,
} from "./types.js";

/** A pure transform over a state value: given the current value, return the next. Must not mutate `current`. */
export type StateMutator<T> = (current: T) => T;

export interface StateLockServiceOptions {
  store: SharedStateStore;
  /** Config caps; resolved from the environment when omitted. */
  caps?: StateLockCaps;
  /** Epoch-ms clock; defaults to `Date.now`. Injected for deterministic tests. */
  now?: () => number;
  /**
   * Per-key serializer. Injectable so a test can prove the *store-level* CAS guards correctness even with
   * the in-process lock disabled. Defaults to a fresh {@link KeyedMutex}.
   */
  mutex?: KeyedMutex;
}

export class StateLockService {
  private readonly store: SharedStateStore;
  private readonly caps: StateLockCaps;
  private readonly now: () => number;
  private readonly mutex: KeyedMutex;

  constructor(options: StateLockServiceOptions) {
    this.store = options.store;
    this.caps = options.caps ?? resolveStateLockCaps();
    this.now = options.now ?? (() => Date.now());
    this.mutex = options.mutex ?? new KeyedMutex();
  }

  /** The configured caps (read-only). */
  getCaps(): StateLockCaps {
    return { ...this.caps };
  }

  /** Seed a new piece of shared state at version 1. Throws {@link StateExistsError} if it already exists. */
  async init<T>(workspaceId: string, key: string, value: T): Promise<SharedStateRecord<T>> {
    const record = await this.store.create<T>({ workspaceId, key, value, updatedAtMs: this.now() });
    assertRecord(record);
    return record;
  }

  /** Load one piece of shared state within a workspace (#3 IDOR scoping); null if absent. */
  async read<T>(workspaceId: string, key: string): Promise<SharedStateRecord<T> | null> {
    return this.store.get<T>(workspaceId, key);
  }

  /** A workspace's shared-state records, ordered by key. */
  async list<T>(workspaceId: string): Promise<SharedStateRecord<T>[]> {
    return this.store.list<T>(workspaceId);
  }

  /**
   * Read-modify-write a piece of shared state under full serialization. `mutator` receives a private copy
   * of the current value and returns the next; the service handles versioning, the timestamp, the CAS, and
   * the retry-on-conflict loop. Resolves to the committed record.
   *
   * Throws {@link StateNotFoundError} if the key was never `init`-ed, {@link StateConflictError} if every
   * attempt in the retry budget lost its race, and {@link InvariantViolationError} if a proposed write
   * would break consistency (which a correct serialized path never produces).
   */
  async update<T>(workspaceId: string, key: string, mutator: StateMutator<T>): Promise<SharedStateRecord<T>> {
    if (!this.caps.enabled) {
      // Escape hatch: skip in-process queuing but keep the optimistic CAS + retry budget (never a blind
      // overwrite), so the store-level backstop alone still guarantees no lost updates across replicas.
      return this.attempt(workspaceId, key, mutator, this.caps.maxRetries);
    }
    // The per-key section makes concurrent writers in this replica strictly sequential, so the CAS inside
    // almost never misses here; the retry budget exists for *cross-replica* contention.
    return this.mutex.runExclusive(lockKey(workspaceId, key), () =>
      this.attempt(workspaceId, key, mutator, this.caps.maxRetries),
    );
  }

  /** Read → mutate → version → CAS, retrying up to `maxRetries` extra times when the CAS loses the race. */
  private async attempt<T>(
    workspaceId: string,
    key: string,
    mutator: StateMutator<T>,
    maxRetries: number,
  ): Promise<SharedStateRecord<T>> {
    let attempts = 0;
    for (;;) {
      attempts++;
      const current = await this.store.get<T>(workspaceId, key);
      if (!current) throw new StateNotFoundError(workspaceId, key);

      const nextValue = mutator(structuredClone(current.value));
      const next: SharedStateRecord<T> = {
        workspaceId: current.workspaceId,
        key: current.key,
        version: current.version + 1,
        value: nextValue,
        updatedAtMs: this.now(),
      };
      // Refuse corruption *before* attempting the commit — a bad transition is a bug, not a conflict.
      assertTransition(current, next);

      const committed = await this.store.compareAndSwap<T>(workspaceId, key, current.version, next);
      if (committed) return committed;

      // A concurrent writer won the CAS. Re-read and retry until the budget is exhausted.
      if (attempts > maxRetries) throw new StateConflictError(workspaceId, key, attempts);
    }
  }
}

/** Re-export for callers that only need the error family. */
export { StateLockError };

/** Compose the per-key lock id from the tenant + entity key (matches the store's row identity). */
function lockKey(workspaceId: string, key: string): string {
  return `${workspaceId} ${key}`;
}
