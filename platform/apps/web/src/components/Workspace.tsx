/** The Slack-style workspace shell: top bar, channel sidebar, message pane, thread + members rails. */
import { useState } from "react";
import { useAppState, useStore } from "../store/StoreContext.js";
import { authorLabel } from "../store/store.js";
import { ChannelSidebar } from "./ChannelSidebar.js";
import { MessagePane } from "./MessagePane.js";
import { ThreadPanel } from "./ThreadPanel.js";
import { MembersRail } from "./MembersRail.js";

export function Workspace(): React.JSX.Element {
  return (
    <div className="workspace">
      <TopBar />
      <div className="workspace__body">
        <ChannelSidebar />
        <MessagePane />
        <ThreadPanel />
        <MembersRail />
      </div>
    </div>
  );
}

function TopBar(): React.JSX.Element {
  const { identity, unreadMentions, mentions, directory } = useAppState();
  const store = useStore();
  const [showMentions, setShowMentions] = useState(false);

  function toggleMentions(): void {
    setShowMentions((v) => !v);
    store.markMentionsRead();
  }

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="auth__mark">◆</span> Reload
      </div>
      <div className="topbar__spacer" />
      {identity && (
        <div className="topbar__me">
          {identity.displayName} · <span className="topbar__kind">{identity.kind}</span>
        </div>
      )}
      <div className="topbar__mentions">
        <button className="iconbtn iconbtn--bell" aria-label="Mentions" onClick={toggleMentions}>
          🔔{unreadMentions > 0 && <span className="badge">{unreadMentions}</span>}
        </button>
        {showMentions && (
          <div className="mention-inbox" role="dialog" aria-label="Mention inbox">
            <h4>Mentions</h4>
            {mentions.length === 0 ? (
              <p className="mention-inbox__empty">No mentions yet.</p>
            ) : (
              <ul>
                {mentions.map((m) => (
                  <li key={m.id}>
                    <strong>{authorLabel(directory, m.authorMemberId)}</strong>: {m.body}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <button className="btn btn--ghost" onClick={() => void store.logout()}>
        Sign out
      </button>
    </header>
  );
}
