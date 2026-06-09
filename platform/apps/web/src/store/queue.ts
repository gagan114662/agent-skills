/**
 * Pure model for the composer message / steering queue (#54). No I/O, no React — just immutable
 * reducers over a per-session (per-channel) queue. The store wires these to the active channel and
 * drains them one at a time through the existing `postMessage` path; see spec 31 / ADR-0031.
 *
 * Invariant on insertion: a **steer** preempts the queued backlog (it lands ahead of every `queue`
 * item but behind earlier steers), mirroring Conductor's "redirect now" semantics. Once items are in
 * the list an explicit reorder is authoritative — `moveItem` does not re-sort by kind.
 */

export type QueueItemKind = "queue" | "steer";

export interface QueueItem {
  id: string;
  text: string;
  kind: QueueItemKind;
}

/** `idle` = ready to drain; `paused` = an inline edit is open and the drain must hold. The in-flight
 * send itself is tracked by the store (a closure guard), not here, so a commit mid-send can't race. */
export type QueueStatus = "idle" | "paused";

export interface SessionQueue {
  items: QueueItem[];
  status: QueueStatus;
  /** The item currently open in the inline editor, or null. A non-null value pauses the drain. */
  editingId: string | null;
  /** The pre-edit text, so a cancel can restore it after partial edits. */
  editOriginal: string | null;
}

export function emptyQueue(): SessionQueue {
  return { items: [], status: "idle", editingId: null, editOriginal: null };
}

/** Append to the tail — sent after everything already pending. */
export function enqueue(q: SessionQueue, item: QueueItem): SessionQueue {
  return { ...q, items: [...q.items, item] };
}

/** Insert ahead of the queued backlog but after any existing steers. */
export function enqueueSteer(q: SessionQueue, item: QueueItem): SessionQueue {
  const firstQueued = q.items.findIndex((i) => i.kind === "queue");
  const at = firstQueued === -1 ? q.items.length : firstQueued;
  const items = [...q.items.slice(0, at), item, ...q.items.slice(at)];
  return { ...q, items };
}

export function removeItem(q: SessionQueue, id: string): SessionQueue {
  const items = q.items.filter((i) => i.id !== id);
  if (q.editingId === id) return { ...q, items, editingId: null, editOriginal: null, status: "idle" };
  return { ...q, items };
}

/** Swap an item with its neighbour. `dir` is -1 (up) or +1 (down); a no-op at the ends. */
export function moveItem(q: SessionQueue, id: string, dir: -1 | 1): SessionQueue {
  const idx = q.items.findIndex((i) => i.id === id);
  if (idx === -1) return q;
  const target = idx + dir;
  if (target < 0 || target >= q.items.length) return q;
  const items = q.items.slice();
  const [moved] = items.splice(idx, 1);
  items.splice(target, 0, moved!);
  return { ...q, items };
}

/** Open `id` in the inline editor and pause the drain, remembering its text for a later cancel. */
export function beginEdit(q: SessionQueue, id: string): SessionQueue {
  const item = q.items.find((i) => i.id === id);
  if (!item) return q;
  return { ...q, status: "paused", editingId: id, editOriginal: item.text };
}

/** Live-update the text of the item being edited; the queue stays paused. */
export function editText(q: SessionQueue, text: string): SessionQueue {
  if (!q.editingId) return q;
  const items = q.items.map((i) => (i.id === q.editingId ? { ...i, text } : i));
  return { ...q, items };
}

/** Keep the edited text, resume the drain; an item trimmed to blank is dropped. */
export function commitEdit(q: SessionQueue): SessionQueue {
  if (!q.editingId) return q;
  const id = q.editingId;
  const items = q.items
    .map((i) => (i.id === id ? { ...i, text: i.text.trim() } : i))
    .filter((i) => i.text.length > 0);
  return { ...q, items, status: "idle", editingId: null, editOriginal: null };
}

/** Discard edits, restoring the remembered text, and resume the drain. */
export function cancelEdit(q: SessionQueue): SessionQueue {
  if (!q.editingId) return q;
  const id = q.editingId;
  const original = q.editOriginal ?? "";
  const items = q.items.map((i) => (i.id === id ? { ...i, text: original } : i));
  return { ...q, items, status: "idle", editingId: null, editOriginal: null };
}

/** Ready to send the next message: idle (not sending, not paused) with something queued. */
export function canDrain(q: SessionQueue): boolean {
  return q.status === "idle" && q.items.length > 0;
}

/** Pop the head for sending. Precondition: `items` is non-empty (guard with `canDrain`). */
export function takeHead(q: SessionQueue): { head: QueueItem; rest: SessionQueue } {
  const [head, ...tail] = q.items;
  return { head: head!, rest: { ...q, items: tail } };
}
