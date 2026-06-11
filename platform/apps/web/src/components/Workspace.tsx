/** The Slack-style workspace shell: top bar, channel sidebar, message pane, thread + members rails.
 * The top bar switches between the chat workspace and the Approvals Panel (#13 governance surface). */
import { useState } from "react";
import { useAppState, useStore } from "../store/StoreContext.js";
import { authorLabel } from "../store/store.js";
import { VOICE } from "../brand.js";
import { Wordmark } from "./Wordmark.js";
import { ChannelSidebar } from "./ChannelSidebar.js";
import { MessagePane } from "./MessagePane.js";
import { ThreadPanel } from "./ThreadPanel.js";
import { MembersRail } from "./MembersRail.js";
import { ApprovalsPanel } from "./approvals/ApprovalsPanel.js";
import { DeployPanel } from "./deploy/DeployPanel.js";
import { FounderPanel } from "./FounderPanel.js";
import { PricingPanel } from "./PricingPanel.js";

// Product chrome surfaces only. Review/Run/Usage stay reachable for operators via the existing
// API/routes (and their panel components remain), but are no longer part of the product nav (#122).
// Pricing (#125) is the customer-facing plan + checkout surface.
type View = "chat" | "approvals" | "deploy" | "founder" | "pricing";

export function Workspace(): React.JSX.Element {
  const [view, setView] = useState<View>("chat");
  return (
    <div className="workspace">
      <TopBar view={view} onSelectView={setView} />
      {/* Keyed on `view` so switching tabs swell-fades the new content in — no hard cut (#145 #7). */}
      <div className="workspace__view view-fade" key={view}>
        {view === "founder" ? (
          <FounderPanel />
        ) : view === "pricing" ? (
          <PricingPanel />
        ) : view === "approvals" ? (
          <ApprovalsPanel />
        ) : view === "deploy" ? (
          <DeployPanel />
        ) : (
          <div className="workspace__body">
            <ChannelSidebar />
            <MessagePane />
            <ThreadPanel />
            <MembersRail />
          </div>
        )}
      </div>
    </div>
  );
}

function TopBar({
  view,
  onSelectView,
}: {
  view: View;
  onSelectView: (v: View) => void;
}): React.JSX.Element {
  const { identity, unreadMentions, mentions, directory, approvals, deploy } = useAppState();
  const deployLive = deploy.latest?.status === "ready" || deploy.latest?.status === "rolled_back";
  const store = useStore();
  const [showMentions, setShowMentions] = useState(false);

  function toggleMentions(): void {
    setShowMentions((v) => !v);
    store.markMentionsRead();
  }

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <Wordmark />
      </div>
      <nav className="topbar__nav" aria-label="Workspace views">
        <button
          className={`topbar__navbtn${view === "chat" ? " topbar__navbtn--active" : ""}`}
          aria-pressed={view === "chat"}
          onClick={() => onSelectView("chat")}
        >
          Chat
        </button>
        <button
          className={`topbar__navbtn${view === "founder" ? " topbar__navbtn--active" : ""}`}
          aria-pressed={view === "founder"}
          onClick={() => onSelectView("founder")}
        >
          Founder
        </button>
        <button
          className={`topbar__navbtn${view === "approvals" ? " topbar__navbtn--active" : ""}`}
          aria-pressed={view === "approvals"}
          onClick={() => onSelectView("approvals")}
        >
          Approvals
          {approvals.pendingCount > 0 && <span className="badge">{approvals.pendingCount}</span>}
        </button>
        <button
          className={`topbar__navbtn${view === "deploy" ? " topbar__navbtn--active" : ""}`}
          aria-pressed={view === "deploy"}
          onClick={() => onSelectView("deploy")}
        >
          Deploy
          {deployLive && <span className="badge badge--live" aria-label="live">●</span>}
        </button>
        <button
          className={`topbar__navbtn${view === "pricing" ? " topbar__navbtn--active" : ""}`}
          aria-pressed={view === "pricing"}
          onClick={() => onSelectView("pricing")}
        >
          Pricing
        </button>
      </nav>
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
              <p className="mention-inbox__empty">{VOICE.noMentions}</p>
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
