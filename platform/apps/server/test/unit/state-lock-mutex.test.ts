import { describe, it, expect } from "vitest";
import { KeyedMutex } from "../../src/state-lock/mutex.js";

/** Resolve on the next microtask — used to widen the window where interleaving could happen. */
const tick = () => Promise.resolve();

describe("KeyedMutex", () => {
  it("serializes sections sharing a key in FIFO order", async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];

    // Each section yields twice before recording, so without the lock they would interleave.
    const run = (id: number) =>
      mutex.runExclusive("k", async () => {
        await tick();
        await tick();
        order.push(id);
      });

    await Promise.all([run(1), run(2), run(3), run(4)]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("never lets two sections sharing a key overlap", async () => {
    const mutex = new KeyedMutex();
    let active = 0;
    let maxActive = 0;

    const run = () =>
      mutex.runExclusive("k", async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await tick();
        active--;
      });

    await Promise.all(Array.from({ length: 50 }, run));
    expect(maxActive).toBe(1);
  });

  it("runs different keys concurrently (the lock is per key, not global)", async () => {
    const mutex = new KeyedMutex();
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const run = (key: string) =>
      mutex.runExclusive(key, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gate; // hold every section open until released
        active--;
      });

    const a = run("a");
    const b = run("b");
    const c = run("c");
    await tick();
    expect(maxActive).toBe(3); // all three keys held the lock simultaneously
    release();
    await Promise.all([a, b, c]);
  });

  it("a throwing section releases the lock and does not poison the queue", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const bad = mutex.runExclusive("k", async () => {
      await tick();
      order.push("bad");
      throw new Error("boom");
    });
    const good = mutex.runExclusive("k", async () => {
      order.push("good");
      return 42;
    });

    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe(42);
    expect(order).toEqual(["bad", "good"]);
  });

  it("propagates the section's return value to its own caller", async () => {
    const mutex = new KeyedMutex();
    const [a, b] = await Promise.all([
      mutex.runExclusive("k", () => "first"),
      mutex.runExclusive("k", () => "second"),
    ]);
    expect([a, b]).toEqual(["first", "second"]);
  });

  it("drops idle keys so the map does not leak", async () => {
    const mutex = new KeyedMutex();
    await mutex.runExclusive("k", () => undefined);
    expect(mutex.activeKeys).toBe(0);
  });
});
