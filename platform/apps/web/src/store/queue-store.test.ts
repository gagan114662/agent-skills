import { describe, expect, it, vi } from "vitest";
import { createStore } from "./store.js";
import { makeFakeDeps, makeMessage } from "../test/utils.js";
import type { Message } from "../api/types.js";

/** Build a store whose `postMessage` is gated: each call parks until released, so tests can
 * observe one-at-a-time draining and ordering. */
function gatedStore() {
  const calls: string[] = [];
  const gates: Array<() => void> = [];
  const { deps, rt } = makeFakeDeps();
  deps.api.postMessage = vi.fn((channelId: string, body: string) => {
    calls.push(body);
    return new Promise<Message>((resolve) => {
      gates.push(() => resolve(makeMessage({ id: `p-${body}`, channelId, body })));
    });
  });
  const store = createStore(deps);
  const release = async (i: number) => {
    gates[i]?.();
    await flush();
  };
  return { store, calls, release, rt };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const activeItems = (store: ReturnType<typeof createStore>) =>
  store.getState().queues.c1?.items ?? [];

describe("store message queue", () => {
  it("drains queued messages one at a time, in order, when each prior send resolves", async () => {
    const { store, calls, release } = gatedStore();
    await store.bootstrap();

    store.queueMessage("a");
    store.queueMessage("b");
    await flush();

    // Only the first is in flight; the second waits behind it.
    expect(calls).toEqual(["a"]);
    expect(activeItems(store).map((i) => i.text)).toEqual(["b"]);

    await release(0);
    expect(calls).toEqual(["a", "b"]);

    await release(1);
    expect(activeItems(store)).toHaveLength(0);
  });

  it("steer preempts queued items; a plain queue lands behind them", async () => {
    const steer = gatedStore();
    await steer.store.bootstrap();
    steer.store.queueMessage("a"); // in flight
    steer.store.queueMessage("b"); // waiting
    await flush();
    steer.store.steerMessage("s"); // jumps ahead of "b"
    await steer.release(0);
    await steer.release(1);
    await steer.release(2);
    expect(steer.calls).toEqual(["a", "s", "b"]);

    const queued = gatedStore();
    await queued.store.bootstrap();
    queued.store.queueMessage("a");
    queued.store.queueMessage("b");
    await flush();
    queued.store.queueMessage("c"); // lands behind "b"
    await queued.release(0);
    await queued.release(1);
    await queued.release(2);
    expect(queued.calls).toEqual(["a", "b", "c"]);
  });

  it("editing a queued message preserves its partial text and pauses the drain", async () => {
    const { store, calls, release } = gatedStore();
    await store.bootstrap();

    store.queueMessage("a"); // in flight
    store.queueMessage("draft message"); // waiting, will be edited
    await flush();
    const id = activeItems(store)[0]!.id;

    store.editQueuedStart(id);
    store.editQueuedChange("draft mes"); // user deletes mid-word
    expect(activeItems(store)[0]?.text).toBe("draft mes");

    // Releasing the in-flight send must NOT drain the paused queue.
    await release(0);
    expect(calls).toEqual(["a"]);

    store.editQueuedCommit();
    await flush();
    expect(calls).toEqual(["a", "draft mes"]);
  });
});
