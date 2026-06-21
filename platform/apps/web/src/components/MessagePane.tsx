/** Center column: the active channel header, its message list, and the composer. */
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useAppState, useStore } from "../store/StoreContext.js";
import { CONSOLE, VOICE, agentColor, departmentColor, starterPromptsFor } from "../brand.js";
import { authorLabel, type AppState, type DirectoryEntry } from "../store/store.js";
import { Avatar, KindBadge } from "./Primitives.js";
import { EmptyState } from "./EmptyState.js";
import { Composer } from "./Composer.js";
import { decideOnNewMessages, isNearBottom } from "./message-scroll.js";
import { useLiveChannelMessages } from "./console/useLiveChannelMessages.js";
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
  const store = useStore();
  const { channels, activeChannelId, messagesByChannel, identity, liveSessions, directory } = state;
  const channel = channels.find((c) => c.id === activeChannelId);

  // #480: in-channel activity — the agents whose session is live in THIS channel right now, so the user sees
  // "Scout is working…" where the work is happening instead of only the global "N running" pill. Empty ⇒
  // nothing running here.
  const workingHere = activeChannelId ? liveSessions.filter((s) => s.channelId === activeChannelId) : [];
  // De-duplicated by display name (a teammate could in theory have two sessions).
  const workingNames = workingHere
    .map((s) => authorLabel(directory, s.agentMemberId))
    .filter((name, i, all) => all.indexOf(name) === i);
  // The server's message list/stream is flat and inclusive of replies (ADR-0006). Slack-style, a
  // reply stays in its thread unless it was explicitly "also sent to channel" — so the channel view
  // shows top-level messages plus replies flagged for the channel.
  const messages = (activeChannelId ? (messagesByChannel[activeChannelId] ?? []) : []).filter(
    (m) => m.parentMessageId === null || m.alsoSentToChannel,
  );

  // #419: keep the open channel fresh as a fallback to the realtime stream, so a dropped / never-delivered
  // socket event self-heals without a manual refresh (the realtime append in the store stays the primary path).
  useLiveChannelMessages(activeChannelId ?? null);

  // #419: scroll management so a working agent's reply is never invisible at the bottom of the feed. The feed
  // follows the conversation when the reader is at the bottom (or just sent a message); a reader who scrolled up
  // to read history gets a "new messages" pill instead of being yanked down.
  const listRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const prevChannelRef = useRef<string | null>(null);
  const prevCountRef = useRef(0);
  const [unread, setUnread] = useState(0);
  // #509: a tapped starter prompt is handed to the composer as a prefill. The bump nonce lets the same
  // prompt be re-applied on a repeat tap (and resets naturally when the channel/messages change).
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);

  function scrollToBottom(): void {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  function handleScroll(): void {
    const el = listRef.current;
    if (!el) return;
    const near = isNearBottom({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    wasNearBottomRef.current = near;
    if (near) setUnread(0);
  }

  useLayoutEffect(() => {
    const count = messages.length;
    // A channel switch (including the first population of a freshly-opened channel) always jumps to the newest
    // message and clears any carried-over unread state — never a stale pill from the previous channel.
    if (prevChannelRef.current !== activeChannelId) {
      prevChannelRef.current = activeChannelId ?? null;
      prevCountRef.current = count;
      wasNearBottomRef.current = true;
      setUnread(0);
      scrollToBottom();
      return;
    }
    const added = count - prevCountRef.current;
    prevCountRef.current = count;
    const newest = messages[messages.length - 1];
    const authoredBySelf = !!identity && newest?.authorMemberId === identity.memberId;
    const action = decideOnNewMessages({ added, wasNearBottom: wasNearBottomRef.current, authoredBySelf });
    if (action === "scroll") {
      scrollToBottom();
      setUnread(0);
    } else if (action === "notify") {
      setUnread((n) => n + added);
    }
  }, [messages, activeChannelId, identity]);

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

      <div className="messagelist" ref={listRef} onScroll={handleScroll}>
        {messages.length === 0 ? (
          <ChannelStarters
            channelName={channel.name}
            onPick={(text) => setPrefill((p) => ({ text, nonce: (p?.nonce ?? 0) + 1 }))}
          />
        ) : (
          messages.map((m) => <MessageItem key={m.id} message={m} state={state} />)
        )}
      </div>

      {unread > 0 && (
        <button
          type="button"
          className="messagelist__newpill"
          onClick={() => {
            scrollToBottom();
            setUnread(0);
          }}
        >
          {unread} new message{unread === 1 ? "" : "s"} ↓
        </button>
      )}

      {workingNames.length > 0 && (
        <div className="typingind" role="status" aria-live="polite">
          <span className="typingind__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="typingind__label">
            {formatWorking(workingNames)} {workingNames.length === 1 ? "is" : "are"} working…
          </span>
          {/* #469: a per-run cancel — the user can stop a run that's taking too long, right where they see it. */}
          <button
            type="button"
            className="typingind__stop"
            aria-label={workingHere.length === 1 ? "Stop this run" : "Stop these runs"}
            onClick={() => workingHere.forEach((s) => void store.stopSession(s.id))}
          >
            {VOICE.stopRun}
          </button>
        </div>
      )}

      <Composer queue draftKey={activeChannelId ?? undefined} prefill={prefill} />
    </section>
  );
}

/**
 * #509: the empty-channel helper. Instead of a dead "Quiet in here" line, an empty channel offers 2–3
 * concrete first actions for that department (e.g. what to ask in #ads vs #seo). Each is a real @-mention
 * brief; tapping one drops it into the composer (focused, editable) rather than sending anything — the
 * human still hits send. Copy comes from brand.ts; the channel's department tints the mark.
 */
function ChannelStarters({
  channelName,
  onPick,
}: {
  channelName: string | null;
  onPick: (text: string) => void;
}): React.JSX.Element {
  const starters = starterPromptsFor(channelName);
  const color = departmentColor(channelName);
  return (
    <div className="messagelist__empty">
      <EmptyState color={color}>{VOICE.noMessages}</EmptyState>
      <div className="starters">
        <p className="starters__heading">{VOICE.startersHeading}</p>
        <ul className="starters__list">
          {starters.map((text) => (
            <li key={text}>
              <button
                type="button"
                className="starters__chip"
                style={color ? ({ "--pop-color": color } as CSSProperties) : undefined}
                onClick={() => onPick(text)}
              >
                {text}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** "Scout" · "Scout and Quill" · "Scout, Quill and 1 more" — a compact list for the working indicator. */
function formatWorking(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
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
