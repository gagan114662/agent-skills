/**
 * The git/PR/review surface (#51). Pick an agent session, review its diff (cumulative or latest
 * turn), leave multiline review comments, deliver them back to the agent as a new session, open a
 * GitHub PR, and watch its checks. Mirrors the Approvals Panel's store-driven shape.
 */
import { useEffect, useState } from "react";
import type { DiffMode } from "@reload/shared";
import type { ModelSelection } from "../../api/types.js";
import { useAppState, useStore } from "../../store/StoreContext.js";
import { DiffView } from "./DiffView.js";
import { ModelBadge, ModelSelector, DEFAULT_SELECTION } from "./ModelSelector.js";

export function ReviewPanel(): React.JSX.Element {
  const { review, activeChannelId } = useAppState();
  const store = useStore();

  useEffect(() => {
    if (activeChannelId) void store.loadReview();
  }, [store, activeChannelId]);

  const activeSession = review.sessions.find((s) => s.id === review.activeSessionId) ?? null;

  return (
    <div className="review">
      <aside className="review__sidebar" aria-label="Sessions">
        <h3>Sessions</h3>
        {review.sessions.length === 0 ? (
          <p className="review__empty">No agent sessions in this channel yet.</p>
        ) : (
          <ul>
            {review.sessions.map((s) => (
              <li key={s.id}>
                <button
                  className={`review__session${s.id === review.activeSessionId ? " review__session--active" : ""}`}
                  aria-pressed={s.id === review.activeSessionId}
                  onClick={() => void store.selectReviewSession(s.id)}
                >
                  <span className="review__session-branch">{s.branch ?? s.id.slice(0, 8)}</span>
                  <span className="review__session-status">{s.status}</span>
                  <ModelBadge session={s} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <LaunchModelControl />
      </aside>

      <section className="review__main">
        {review.error && <p className="review__error" role="alert">{review.error}</p>}
        {activeSession ? (
          <>
            <DiffHeader mode={review.diffMode} onMode={(m) => void store.setDiffMode(m)} />
            <DiffView patch={review.diff?.patch ?? ""} files={review.diff?.files ?? []} />
            <CommentComposer />
            <CommentList />
          </>
        ) : (
          <p className="review__empty">Select a session to review its diff.</p>
        )}
      </section>

      <aside className="review__prs" aria-label="Pull requests">
        <CreatePrForm disabled={!activeSession} />
        <PrList />
      </aside>
    </div>
  );
}

/**
 * The model/provider/effort/Auto selection a new session would launch with (#52). Sessions are
 * launched via @mention or the launch API; this surfaces the selection control + previews the choice
 * that `api.review.launchSession` would send. Local state — it gathers intent without a store round-trip.
 */
function LaunchModelControl(): React.JSX.Element {
  const [selection, setSelection] = useState<ModelSelection>(DEFAULT_SELECTION);
  return (
    <div className="review__launch" aria-label="New session model">
      <h3>New session model</h3>
      <ModelSelector value={selection} onChange={setSelection} />
      <p className="review__launch-preview">
        {selection.mode === "auto"
          ? "Auto · Opus plans → Sonnet implements"
          : `${selection.provider} · ${selection.model || "(default)"}${
              selection.effort !== "off" ? ` · ${selection.effort}` : ""
            }`}
      </p>
    </div>
  );
}

function DiffHeader({ mode, onMode }: { mode: DiffMode; onMode: (m: DiffMode) => void }): React.JSX.Element {
  return (
    <div className="review__diffhead">
      <h3>Diff</h3>
      <div className="review__modes" role="group" aria-label="Diff mode">
        {(["cumulative", "turn"] as DiffMode[]).map((m) => (
          <button
            key={m}
            className={`review__mode${mode === m ? " review__mode--active" : ""}`}
            aria-pressed={mode === m}
            onClick={() => onMode(m)}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  );
}

function CommentComposer(): React.JSX.Element {
  const store = useStore();
  const [filePath, setFilePath] = useState("");
  const [lineStart, setLineStart] = useState("");
  const [lineEnd, setLineEnd] = useState("");
  const [body, setBody] = useState("");

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    if (!filePath.trim() || !body.trim()) return;
    void store.addReviewComment({
      filePath: filePath.trim(),
      lineStart: lineStart ? Number(lineStart) : null,
      lineEnd: lineEnd ? Number(lineEnd) : null,
      body: body.trim(),
    });
    setBody("");
  }

  return (
    <form className="review__comment-form" onSubmit={submit} aria-label="Add review comment">
      <div className="review__comment-loc">
        <input aria-label="File path" placeholder="src/file.ts" value={filePath} onChange={(e) => setFilePath(e.target.value)} />
        <input aria-label="Line start" placeholder="line" value={lineStart} onChange={(e) => setLineStart(e.target.value)} />
        <input aria-label="Line end" placeholder="end" value={lineEnd} onChange={(e) => setLineEnd(e.target.value)} />
      </div>
      <textarea aria-label="Comment body" placeholder="Leave a review comment…" value={body} onChange={(e) => setBody(e.target.value)} />
      <button className="btn" type="submit" disabled={!filePath.trim() || !body.trim()}>
        Comment
      </button>
    </form>
  );
}

function CommentList(): React.JSX.Element {
  const { review } = useAppState();
  const store = useStore();
  const undelivered = review.comments.filter((c) => !c.deliveredToSessionId).length;

  return (
    <div className="review__comments">
      <div className="review__comments-head">
        <h3>Review comments</h3>
        <button
          className="btn btn--primary"
          disabled={undelivered === 0}
          onClick={() => void store.deliverComments()}
        >
          Deliver to agent{undelivered > 0 ? ` (${undelivered})` : ""}
        </button>
      </div>
      {review.comments.length === 0 ? (
        <p className="review__empty">No comments yet.</p>
      ) : (
        <ul>
          {review.comments.map((c) => (
            <li key={c.id} className="review__comment">
              <code className="review__comment-loc-label">
                {c.filePath}
                {c.lineStart ? `:${c.lineStart}${c.lineEnd && c.lineEnd !== c.lineStart ? `-${c.lineEnd}` : ""}` : ""}
              </code>
              <span className="review__comment-body">{c.body}</span>
              {c.deliveredToSessionId && <span className="review__comment-delivered">delivered ✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreatePrForm({ disabled }: { disabled: boolean }): React.JSX.Element {
  const store = useStore();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    if (!title.trim()) return;
    void store.createPullRequest({ title: title.trim(), body: body.trim() || undefined, draft });
    setTitle("");
    setBody("");
  }

  return (
    <form className="review__pr-form" onSubmit={submit} aria-label="Create pull request">
      <h3>Create PR</h3>
      <input aria-label="PR title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={disabled} />
      <textarea aria-label="PR description" placeholder="Description" value={body} onChange={(e) => setBody(e.target.value)} disabled={disabled} />
      <label className="review__pr-draft">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} disabled={disabled} /> Draft
      </label>
      <button className="btn btn--primary" type="submit" disabled={disabled || !title.trim()}>
        Create PR
      </button>
    </form>
  );
}

function PrList(): React.JSX.Element {
  const { review } = useAppState();
  const store = useStore();
  return (
    <div className="review__prlist">
      <h3>Pull requests</h3>
      {review.pullRequests.length === 0 ? (
        <p className="review__empty">No PRs yet.</p>
      ) : (
        <ul>
          {review.pullRequests.map((pr) => (
            <li key={pr.id} className="review__pr">
              <div className="review__pr-title">
                {pr.url ? (
                  <a href={pr.url} target="_blank" rel="noreferrer">
                    {pr.number ? `#${pr.number} ` : ""}
                    {pr.title}
                  </a>
                ) : (
                  <span>{pr.title}</span>
                )}
              </div>
              <div className="review__pr-meta">
                <span className={`review__pr-state review__pr-state--${pr.state}`}>{pr.state}</span>
                <span className={`review__pr-checks review__pr-checks--${pr.checksStatus}`}>
                  checks: {pr.checksStatus}
                </span>
              </div>
              <div className="review__pr-actions">
                <button className="btn btn--ghost" onClick={() => void store.refreshChecks(pr.id)}>
                  Refresh checks
                </button>
                {pr.checksStatus === "failure" && (
                  <button className="btn" onClick={() => void store.fixCi(pr.id)}>
                    Fix CI
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
