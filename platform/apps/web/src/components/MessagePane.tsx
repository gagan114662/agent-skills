/** Center column: the active channel header, its message list, and the composer. */
import { useAppState, useStore } from "../store/StoreContext.js";
import { VOICE } from "../brand.js";
import { authorLabel, type AppState } from "../store/store.js";
import { Avatar, KindBadge } from "./Primitives.js";
import { Composer } from "./Composer.js";
import type { Message } from "../api/types.js";

export function MessagePane(): React.JSX.Element {
  const state = useAppState();
  const { channels, activeChannelId, messagesByChannel } = state;
  const channel = channels.find((c) => c.id === activeChannelId);
  // The server's message list/stream is flat and inclusive of replies (ADR-0006). Slack-style, a
  // reply stays in its thread unless it was explicitly "also sent to channel" — so the channel view
  // shows top-level messages plus replies flagged for the channel.
  const messages = (activeChannelId ? (messagesByChannel[activeChannelId] ?? []) : []).filter(
    (m) => m.parentMessageId === null || m.alsoSentToChannel,
  );

  if (!channel) {
    return (
      <section className="pane pane--empty">
        <div className="pane--empty__mark" aria-hidden="true" />
        <p>{VOICE.emptyChannel}</p>
      </section>
    );
  }

  const title = channel.kind === "dm" ? "Direct message" : `# ${channel.name ?? "channel"}`;

  return (
    <section className="pane" aria-label={`Messages in ${title}`}>
      <header className="pane__head">
        <h2 className="pane__title">{title}</h2>
        <span className="pane__sub">{messages.length} messages</span>
      </header>

      <div className="messagelist">
        {messages.length === 0 ? (
          <p className="messagelist__empty">{VOICE.noMessages}</p>
        ) : (
          messages.map((m) => <MessageItem key={m.id} message={m} state={state} />)
        )}
      </div>

      <Composer queue />
    </section>
  );
}

function MessageItem({ message, state }: { message: Message; state: AppState }): React.JSX.Element {
  const store = useStore();
  const entry = state.directory[message.authorMemberId];
  const name = authorLabel(state.directory, message.authorMemberId);
  const kind = entry?.kind ?? "human";
  const isReply = message.parentMessageId !== null;

  return (
    <article className={`message${kind === "agent" ? " message--agent" : ""}`}>
      <Avatar name={name} kind={kind} />
      <div className="message__body">
        <div className="message__meta">
          <span className="message__author">{name}</span>
          {kind === "agent" && <KindBadge kind="agent" />}
          {isReply && <span className="message__replytag">in thread</span>}
          {message.alsoSentToChannel && <span className="message__replytag">also to channel</span>}
        </div>
        <div className="message__text">{message.body}</div>
        <button
          className="message__thread"
          onClick={() => void store.openThread(message.id)}
          aria-label="Reply in thread"
        >
          💬 Reply in thread
        </button>
      </div>
    </article>
  );
}
