import { describe, expect, it } from "vitest";
import {
  beginEdit,
  cancelEdit,
  canDrain,
  commitEdit,
  editText,
  emptyQueue,
  enqueue,
  enqueueSteer,
  moveItem,
  removeItem,
  takeHead,
  type QueueItem,
} from "./queue.js";

const item = (id: string, text = id, kind: QueueItem["kind"] = "queue"): QueueItem => ({
  id,
  text,
  kind,
});

describe("queue model", () => {
  it("enqueue appends to the tail", () => {
    let q = emptyQueue();
    q = enqueue(q, item("a"));
    q = enqueue(q, item("b"));
    expect(q.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(q.status).toBe("idle");
  });

  it("steer inserts ahead of queued items but after existing steers", () => {
    let q = emptyQueue();
    q = enqueue(q, item("q1"));
    q = enqueue(q, item("q2"));
    q = enqueueSteer(q, item("s1", "s1", "steer"));
    q = enqueueSteer(q, item("s2", "s2", "steer"));
    // steers keep their own order and collectively preempt the queued backlog
    expect(q.items.map((i) => i.id)).toEqual(["s1", "s2", "q1", "q2"]);
  });

  it("removeItem drops by id", () => {
    let q = enqueue(enqueue(emptyQueue(), item("a")), item("b"));
    q = removeItem(q, "a");
    expect(q.items.map((i) => i.id)).toEqual(["b"]);
  });

  it("moveItem reorders within bounds and is a no-op at the ends", () => {
    let q = enqueue(enqueue(enqueue(emptyQueue(), item("a")), item("b")), item("c"));
    q = moveItem(q, "b", -1);
    expect(q.items.map((i) => i.id)).toEqual(["b", "a", "c"]);
    q = moveItem(q, "b", -1); // already at the head
    expect(q.items.map((i) => i.id)).toEqual(["b", "a", "c"]);
    q = moveItem(q, "c", 1); // already at the tail
    expect(q.items.map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("beginEdit pauses the queue and editText preserves the partial text", () => {
    let q = enqueue(emptyQueue(), item("a", "hello"));
    q = beginEdit(q, "a");
    expect(q.status).toBe("paused");
    expect(q.editingId).toBe("a");
    q = editText(q, "hel"); // user deletes mid-word — partial is kept
    expect(q.items[0]?.text).toBe("hel");
    expect(q.status).toBe("paused"); // still paused while editing
  });

  it("commitEdit keeps the edited text and resumes; cancelEdit restores the original", () => {
    let q = enqueue(emptyQueue(), item("a", "original"));
    q = editText(beginEdit(q, "a"), "changed");
    const committed = commitEdit(q);
    expect(committed.items[0]?.text).toBe("changed");
    expect(committed.status).toBe("idle");
    expect(committed.editingId).toBeNull();

    const cancelled = cancelEdit(q);
    expect(cancelled.items[0]?.text).toBe("original");
    expect(cancelled.status).toBe("idle");
  });

  it("commitEdit drops an item edited down to blank", () => {
    let q = enqueue(emptyQueue(), item("a", "x"));
    q = commitEdit(editText(beginEdit(q, "a"), "   "));
    expect(q.items).toHaveLength(0);
  });

  it("canDrain is false while paused and takeHead pops the head", () => {
    const q = enqueue(enqueue(emptyQueue(), item("a")), item("b"));
    expect(canDrain(q)).toBe(true);
    const { head, rest } = takeHead(q);
    expect(head.id).toBe("a");
    expect(rest.items.map((i) => i.id)).toEqual(["b"]);

    const paused = beginEdit(q, "a");
    expect(canDrain(paused)).toBe(false);
  });
});
