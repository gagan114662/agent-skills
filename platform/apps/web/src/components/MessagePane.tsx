/** Center column: the active channel header, its message list, and the composer. */
import { useAppState, useStore } from "../store/StoreContext.js";
import { CONSOLE, VOICE, agentColor } from "../brand.js";
import { authorLabel, type AppState, type DirectoryEntry } from "../store/store.js";
import { Avatar, KindBadge } from "./Primitives.js";
import { EmptyState } from "./EmptyState.js";
import { Composer } from "./Composer.js";
import type { Message } from "../api/types.js";

export interface MessagePaneProps {
  /**
   * When set (#378), the pane is framed as a 1:1 DIRECT MESSAGE with this member — the header reads "Direct
   * message with {name}" instead of the channel hash. The message stream itself is still the resolved
   * channel's (an agent's 1:1 is its department channel), so the history is real, not invented.
   */
  dmPeer?: DirectoryEntry | null;
}

export function MessagePane({ dmPeer }: MessagePaneProps = {}): React.JSX.Element {
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

  // #378: a DM peer reframes the header as a 1:1 ("Direct message with Scout"); otherwise the channel hash.
  const dmColor = dmPeer?.kind === "agent" ? agentColor(dmPeer.displayName) : undefined;
  const title = dmPeer
    ? `${CONSOLE.coordination.dm.title} ${CONSOLE.coordination.dm.withPrefix} ${dmPeer.displayName}`
    : channel.kind === "dm"
      ? CONSOLE.coordination.dm.title
      : `# ${channel.name ?? "channel"}`;

  return (
    <section className="pane" aria-label={`Messages in ${title}`}>
      <header className="pane__head">
        <h2 className="pane__title" style={dmColor ? { color: dmColor } : undefined}>
          {title}
        </h2>
        <span className="pane__sub">{messages.length} messages</span>
      </header>

      <div className="messagelist">
        {messages.length === 0 ? (
          <EmptyState className="messagelist__empty">{VOICE.noMessages}</EmptyState>
        ) : (
          messages.map((m) => <MessageItem key={m.id} message={m} state={state} />)
        )}
      </div>

      <Composer queue draftKey={activeChannelId ?? undefined} />
    </section>
  );
}

function MessageItem({ message, state }: { message: Message; state: AppState }): React.JSX.Element {
  const store = useStore();
  const entry = state.directory[message.authorMemberId];
  const name = authorLabel(state.directory, message.authorMemberId);
  const kind = entry?.kind ?? "human";
  const isReply = message.parentMessageId !== null;
  const deptColor = kind === "agent" ? agentColor(name) : undefined;

  return (
    <article className={`message${kind === "agent" ? " message--agent" : ""}`}>
      <Avatar name={name} kind={kind} />
      <div className="message__body">
        <div className="message__meta">
          <span
            className={`message__author${kind === "agent" ? " message__author--agent" : ""}`}
            style={deptColor ? ({ "--pop-color": deptColor } as React.CSSProperties) : undefined}
          >
            {name}
          </span>
          {kind === "agent" && <KindBadge kind="agent" color={deptColor} />}
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
