/**
 * Per-entity serialization primitive (issue #639) — the in-process half of the fix. A {@link KeyedMutex}
 * funnels every critical section that shares a key through a single FIFO queue, so two coroutines that
 * read-modify-write the same entity can never interleave their await points and clobber each other. Work
 * on *different* keys runs fully concurrently (the lock is per key, not global), so serializing entity A's
 * writers never blocks entity B's.
 *
 * This is pure, dependency-free, and IO-agnostic: it knows nothing about Postgres or the shared-state
 * store. The store layer adds the *cross-process* half (an optimistic version CAS, and — in the Pg binding
 * — a transactional advisory lock); the mutex adds the *in-process* half. Together a single replica never
 * loses an update, and multiple replicas detect contention via the CAS rather than corrupting state.
 */

/** A critical section: an async (or sync) thunk run under the lock. */
export type CriticalSection<T> = () => Promise<T> | T;

/**
 * A fair, per-key async mutex. `runExclusive(key, fn)` runs `fn` only after every previously-enqueued
 * section for the same `key` has settled, and before any enqueued later — strict FIFO. A section that
 * throws releases the lock and propagates to *its* caller without poisoning the queue: the next waiter
 * still runs. Keys are independent, so the queues never contend with each other.
 */
export class KeyedMutex {
  /** Per-key tail of the promise chain. A tail never rejects (errors are absorbed) so the chain survives. */
  private readonly tails = new Map<string, Promise<void>>();

  /** Run `fn` exclusively with respect to other sections sharing `key`. Resolves/rejects with `fn`'s result. */
  async runExclusive<T>(key: string, fn: CriticalSection<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // `run` waits its turn (prev never rejects) then executes the section.
    const run = prev.then(() => fn());
    // The new tail is `run` with its result/▸error absorbed, so the next waiter always proceeds.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await run;
    } finally {
      // Drop the key once this section was the last one queued, so idle keys don't leak memory.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Number of keys with an in-flight or queued section — diagnostics only. */
  get activeKeys(): number {
    return this.tails.size;
  }
}
