/** The Slack-style workspace shell: top bar, channel sidebar, message pane, thread + members rails.
 * The top bar switches between the chat workspace and the Approvals Panel (#13 governance surface). */
import { useState } from "react";
import { useAppState, useStore } from "../store/StoreContext.js";
import { authorLabel } from "../store/store.js";
import { ChannelSidebar } from "./ChannelSidebar.js";
import { MessagePane } from "./MessagePane.js";
import { ThreadPanel } from "./ThreadPanel.js";
import { MembersRail } from "./MembersRail.js";
import { ApprovalsPanel } from "./approvals/ApprovalsPanel.js";
import { ReviewPanel } from "./review/ReviewPanel.js";
import { RunPanel } from "./run/RunPanel.js";
import { UsagePanel } from "./UsagePanel.js";
import { DeployPanel } from "./deploy/DeployPanel.js";
import { FounderPanel } from "./FounderPanel.js";

type View = "chat" | "approvals" | "review" | "run" | "usage" | "deploy" | "founder";

export function Workspace(): React.JSX.Element {
  const [view, setView] = useState<View>("chat");
  return (
    <div className="workspace">
      <TopBar view={view} onSelectView={setView} />
      {view === "founder" ? (
        <FounderPanel />
      ) : view === "approvals" ? (
        <ApprovalsPanel />
      ) : view === "review" ? (
        <ReviewPanel />
      ) : view === "run" ? (
        <RunPanel />
      ) : view === "usage" ? (
        <UsagePanel />
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
  );
}

function TopBar({
  view,
  onSelectView,
}: {
  view: View;
  onSelectView: (v: View) => void;
}): React.JSX.Element {
  const { identity, unreadMentions, mentions, directory, approvals, review, run, deploy } = useAppState();
  const runLive = run.process?.status === "running" || run.process?.status === "starting";
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
        <span className="auth__mark">◆</span> Reload
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
          className={`topbar__navbtn${view === "review" ? " topbar__navbtn--active" : ""}`}
          aria-pressed={view === "review"}
          onClick={() => onSelectView("review")}
        >
          Review
          {review.pullRequests.length > 0 && <span className="badge">{review.pullRequests.length}</span>}
        </button>
        <button
          className={`topbar__navbtn${view === "run" ? " topbar__navbtn--active" : ""}`}
          aria-pressed={view === "run"}
          onClick={() => onSelectView("run")}
        >
          Run
          {runLive && <span className="badge badge--live" aria-label="running">●</span>}
        </button>
        <button
          className={`topbar__navbtn${view === "usage" ? " topbar__navbtn--active" : ""}`}
          aria-pressed={view === "usage"}
          onClick={() => onSelectView("usage")}
        >
          Usage
        </button>
        <button
          className={`topbar__navbtn${view === "deploy" ? " topbar__navbtn--active" : ""}`}
          aria-pressed={view === "deploy"}
          onClick={() => onSelectView("deploy")}
        >
          Deploy
          {deployLive && <span className="badge badge--live" aria-label="live">●</span>}
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
