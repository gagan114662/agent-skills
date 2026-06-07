/** Right column thread view: the root message, its replies, and a reply composer (#6). */
import { useState } from "react";
import { useAppState, useStore } from "../store/StoreContext.js";
import { authorLabel } from "../store/store.js";
import { Avatar, KindBadge } from "./Primitives.js";
import { Composer } from "./Composer.js";
import type { Message } from "../api/types.js";

export function ThreadPanel(): React.JSX.Element | null {
  const { thread, directory } = useAppState();
  const store = useStore();
  const [alsoSend, setAlsoSend] = useState(false);

  if (!thread) return null;

  return (
    <aside className="thread" aria-label="Thread">
      <header className="thread__head">
        <h3>Thread</h3>
        <button className="iconbtn" aria-label="Close thread" onClick={() => store.closeThread()}>
          ✕
        </button>
      </header>

      <div className="thread__scroll">
        <ThreadMessage message={thread.root} directory={directory} root />
        <div className="thread__count">
          {thread.replies.length} {thread.replies.length === 1 ? "reply" : "replies"}
        </div>
        {thread.replies.map((r) => (
          <ThreadMessage key={r.id} message={r} directory={directory} />
        ))}
      </div>

      <div className="thread__composer">
        <label className="thread__also">
          <input
            type="checkbox"
            checked={alsoSend}
            onChange={(e) => setAlsoSend(e.target.checked)}
          />
          Also send to channel
        </label>
        <Composer
          compact
          placeholder="Reply…"
          onSubmit={(text) => store.sendReply(thread.root.id, text, alsoSend)}
        />
      </div>
    </aside>
  );
}

function ThreadMessage({
  message,
  directory,
  root,
}: {
  message: Message;
  directory: ReturnType<typeof useAppState>["directory"];
  root?: boolean;
}): React.JSX.Element {
  const entry = directory[message.authorMemberId];
  const name = authorLabel(directory, message.authorMemberId);
  const kind = entry?.kind ?? "human";
  return (
    <article className={`message${root ? " message--root" : ""}${kind === "agent" ? " message--agent" : ""}`}>
      <Avatar name={name} kind={kind} />
      <div className="message__body">
        <div className="message__meta">
          <span className="message__author">{name}</span>
          {kind === "agent" && <KindBadge kind="agent" />}
        </div>
        <div className="message__text">{message.body}</div>
      </div>
    </article>
  );
}
