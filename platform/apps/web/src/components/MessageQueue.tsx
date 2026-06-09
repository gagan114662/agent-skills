/**
 * The per-session composer queue surface (#54): the list of messages stacked for the active channel,
 * with inline edit, reorder, delete, and keyboard navigation. Rendered above the channel `Composer`.
 * Sending is the store's job (a one-at-a-time drain); this component only manages the pending list.
 */
import { useState, type KeyboardEvent } from "react";
import { useAppState, useStore } from "../store/StoreContext.js";
import type { QueueItem } from "../store/store.js";

export function MessageQueue(): React.JSX.Element | null {
  const { activeChannelId, queues } = useAppState();
  const store = useStore();
  const queue = activeChannelId ? queues[activeChannelId] : undefined;
  const items = queue?.items ?? [];
  const editingId = queue?.editingId ?? null;
  const [selected, setSelected] = useState(-1);

  if (items.length === 0) return null;

  const sel = selected < 0 ? -1 : Math.min(selected, items.length - 1);

  function onKeyDown(e: KeyboardEvent<HTMLUListElement>): void {
    if (editingId) return; // the inline editor owns keys while open
    const cur = items[sel];
    switch (e.key) {
      case "ArrowDown":
        if (e.altKey && cur) {
          e.preventDefault();
          store.moveQueued(cur.id, 1);
          setSelected(Math.min(items.length - 1, sel + 1));
        } else {
          e.preventDefault();
          setSelected((i) => Math.min(items.length - 1, i + 1));
        }
        return;
      case "ArrowUp":
        if (e.altKey && cur) {
          e.preventDefault();
          store.moveQueued(cur.id, -1);
          setSelected(Math.max(0, sel - 1));
        } else {
          e.preventDefault();
          setSelected((i) => Math.max(0, i - 1));
        }
        return;
      case "Enter":
        if (cur) {
          e.preventDefault();
          store.editQueuedStart(cur.id);
        }
        return;
      case "Delete":
      case "Backspace":
        if (cur) {
          e.preventDefault();
          store.removeQueued(cur.id);
          setSelected(Math.max(0, Math.min(sel, items.length - 2)));
        }
        return;
      default:
        return;
    }
  }

  return (
    <div className="queue" aria-label="Message queue">
      <div className="queue__head">
        Queued · {items.length}
        <span className="queue__hint">⌘↵ queue · ⌥↵ steer</span>
      </div>
      <ul
        className="queue__list"
        aria-label="Queued messages"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {items.map((item, i) => (
          <QueueRow
            key={item.id}
            item={item}
            index={i}
            count={items.length}
            selected={i === sel}
            editing={item.id === editingId}
            onSelect={() => setSelected(i)}
          />
        ))}
      </ul>
    </div>
  );
}

function QueueRow({
  item,
  index,
  count,
  selected,
  editing,
  onSelect,
}: {
  item: QueueItem;
  index: number;
  count: number;
  selected: boolean;
  editing: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const store = useStore();

  if (editing) {
    return (
      <li className="queue__row queue__row--editing">
        <textarea
          className="queue__editor"
          aria-label="Edit queued message"
          autoFocus
          value={item.text}
          onChange={(e) => store.editQueuedChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              store.editQueuedCommit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              store.editQueuedCancel();
            }
          }}
        />
        <div className="queue__rowbtns">
          <button className="btn btn--primary btn--small" type="button" onClick={() => store.editQueuedCommit()}>
            Save
          </button>
          <button className="btn btn--ghost btn--small" type="button" onClick={() => store.editQueuedCancel()}>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={`queue__row${selected ? " queue__row--selected" : ""}`}
      aria-current={selected || undefined}
      onMouseDown={onSelect}
    >
      <span className={`queue__kind queue__kind--${item.kind}`}>
        {item.kind === "steer" ? "Steer" : "Queued"}
      </span>
      <span className="queue__text">{item.text}</span>
      <div className="queue__rowbtns">
        <button
          className="iconbtn"
          type="button"
          aria-label="Move up"
          disabled={index === 0}
          onClick={() => store.moveQueued(item.id, -1)}
        >
          ↑
        </button>
        <button
          className="iconbtn"
          type="button"
          aria-label="Move down"
          disabled={index === count - 1}
          onClick={() => store.moveQueued(item.id, 1)}
        >
          ↓
        </button>
        <button className="iconbtn" type="button" aria-label="Edit message" onClick={() => store.editQueuedStart(item.id)}>
          ✎
        </button>
        <button
          className="iconbtn"
          type="button"
          aria-label="Remove from queue"
          onClick={() => store.removeQueued(item.id)}
        >
          ✕
        </button>
      </div>
    </li>
  );
}
