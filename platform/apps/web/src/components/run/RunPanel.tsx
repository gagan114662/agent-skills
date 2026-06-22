/**
 * The Run tab (#56): pick an agent session, run its app, preview the running localhost app in an
 * in-app iframe, click the preview (in Annotate mode) to drop coordinate-anchored notes, and deliver
 * the collected annotations back to the agent as a follow-up session (the #51 round trip, anchored to
 * the running UI instead of diff lines). Mirrors the Review Panel's store-driven, channel-scoped shape.
 *
 * The localhost app is cross-origin, so we never read the iframe's DOM — annotations are positions on
 * our own overlay (normalized 0–1 fractions of the preview viewport) plus the user's typed note.
 */
import { useEffect, useState } from "react";
import type { PreviewAnnotation } from "@reload/shared";
import type { AgentSessionSummary } from "../../api/types.js";
import { useAppState, useStore } from "../../store/StoreContext.js";

export function RunPanel(): React.JSX.Element {
  const { run, activeChannelId } = useAppState();
  const store = useStore();

  useEffect(() => {
    if (activeChannelId) void store.loadRun();
  }, [store, activeChannelId]);

  const activeSession = run.sessions.find((s) => s.id === run.activeSessionId) ?? null;

  return (
    <div className="run">
      <aside className="run__sidebar" aria-label="Sessions">
        <h3>Sessions</h3>
        {run.sessions.length === 0 ? (
          <p className="run__empty">No agent sessions in this channel yet.</p>
        ) : (
          <ul>
            {run.sessions.map((s) => (
              <li key={s.id}>
                <button
                  className={`run__session${s.id === run.activeSessionId ? " run__session--active" : ""}`}
                  aria-pressed={s.id === run.activeSessionId}
                  onClick={() => void store.selectRunSession(s.id)}
                >
                  <span className="run__session-branch">{s.branch ?? s.id.slice(0, 8)}</span>
                  <span
                    className={`run__session-status${s.failure ? " run__session-status--failed" : ""}`}
                  >
                    {s.failure ? `❌ ${s.status}` : s.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="run__main">
        {run.error && (
          <p className="run__error" role="alert">
            {run.error}
          </p>
        )}
        {activeSession?.failure && <RunFailureBanner session={activeSession} />}
        {activeSession ? <RunStage /> : <p className="run__empty">Select a session to run its app.</p>}
      </section>

      <aside className="run__rail" aria-label="Annotations">
        <AnnotationList />
      </aside>
    </div>
  );
}

/**
 * The never-silent failure surface (#634). When the selected run failed, show the human-readable cause
 * (headline + what-to-do-next), the failing step (terminal status + classified reason), and a retry
 * affordance. The original task isn't persisted server-side, so retry re-briefs the agent: the operator
 * confirms/edits the task, then re-launches the same agent + model selection on it.
 */
function RunFailureBanner({ session }: { session: AgentSessionSummary }): React.JSX.Element | null {
  const store = useStore();
  const [task, setTask] = useState("");
  const [retrying, setRetrying] = useState(false);
  const failure = session.failure;
  if (!failure) return null;

  async function retry(): Promise<void> {
    if (!task.trim() || retrying) return;
    setRetrying(true);
    try {
      await store.retryRunSession(session.id, task);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <section className="run__failure" role="alert" aria-label="Run failed">
      <p className="run__failure-headline">❌ {failure.headline}</p>
      <p className="run__failure-detail">{failure.detail}</p>
      <p className="run__failure-step">
        Failing step: <code>{session.status}</code> <span className="run__failure-class">({failure.failureClass})</span>
      </p>
      <div className="run__failure-retry">
        <input
          aria-label="Re-brief and retry"
          placeholder="Re-brief the agent, then retry"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          disabled={retrying}
        />
        <button
          className="btn btn--primary"
          onClick={() => void retry()}
          disabled={!task.trim() || retrying}
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </div>
    </section>
  );
}

function RunStage(): React.JSX.Element {
  const { run } = useAppState();
  const store = useStore();
  const [annotateMode, setAnnotateMode] = useState(false);
  const proc = run.process;
  const status = proc?.status ?? "idle";
  const active = status === "starting" || status === "running";
  const running = status === "running";

  return (
    <>
      <div className="run__controls">
        <span className={`run__status run__status--${status}`}>{status}</span>
        {proc?.url && (
          <a className="run__url" href={proc.url} target="_blank" rel="noreferrer">
            {proc.url}
          </a>
        )}
        {active ? (
          <button className="btn" onClick={() => void store.stopRun()}>
            Stop
          </button>
        ) : (
          <button className="btn btn--primary" onClick={() => void store.startRun()}>
            Run app
          </button>
        )}
        <button
          className={`btn btn--ghost${annotateMode ? " run__annotate--on" : ""}`}
          aria-pressed={annotateMode}
          disabled={!running}
          onClick={() => setAnnotateMode((v) => !v)}
        >
          {annotateMode ? "Annotating…" : "Annotate"}
        </button>
      </div>
      <RunPreview annotateMode={annotateMode} />
      <RunLogs logs={proc?.logs ?? []} />
    </>
  );
}

function RunPreview({ annotateMode }: { annotateMode: boolean }): React.JSX.Element {
  const { run } = useAppState();
  const store = useStore();
  const proc = run.process;
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null);
  const [note, setNote] = useState("");

  if (!proc?.url || proc.status !== "running") {
    return (
      <div className="run__preview run__preview--empty">
        {proc?.status === "starting" ? "Starting the app…" : "Run the app to preview it here."}
      </div>
    );
  }
  const url = proc.url;

  function onOverlayClick(e: React.MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.width ? (e.clientX - rect.left) / rect.width : 0;
    const y = rect.height ? (e.clientY - rect.top) / rect.height : 0;
    setPending({ x: clamp01(x), y: clamp01(y) });
  }

  function save(): void {
    if (!pending || !note.trim()) return;
    const annotation: PreviewAnnotation = { x: pending.x, y: pending.y, note: note.trim(), pageUrl: url };
    store.addAnnotation(annotation);
    setPending(null);
    setNote("");
  }

  return (
    <div className="run__preview">
      <iframe className="run__iframe" title="App preview" src={url} />
      <div
        className={`run__overlay${annotateMode ? " run__overlay--active" : ""}`}
        style={{ pointerEvents: annotateMode ? "auto" : "none" }}
        onClick={annotateMode ? onOverlayClick : undefined}
        data-testid="run-overlay"
      >
        {run.annotations.map((a, i) => (
          <span
            key={i}
            className="run__pin"
            style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }}
            title={a.note}
          />
        ))}
        {pending && (
          <div
            className="run__pin-form"
            style={{ left: `${pending.x * 100}%`, top: `${pending.y * 100}%` }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              aria-label="Annotation note"
              placeholder="What should change here?"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button className="btn" onClick={save} disabled={!note.trim()}>
              Add
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function RunLogs({ logs }: { logs: string[] }): React.JSX.Element | null {
  if (logs.length === 0) return null;
  return (
    <pre className="run__logs" aria-label="Run logs">
      {logs.join("\n")}
    </pre>
  );
}

function AnnotationList(): React.JSX.Element {
  const { run } = useAppState();
  const store = useStore();
  return (
    <div className="run__annotations">
      <div className="run__annotations-head">
        <h3>Annotations</h3>
        <button
          className="btn btn--primary"
          disabled={run.annotations.length === 0}
          onClick={() => void store.deliverAnnotations()}
        >
          Deliver to agent{run.annotations.length > 0 ? ` (${run.annotations.length})` : ""}
        </button>
      </div>
      {run.annotations.length === 0 ? (
        <p className="run__empty">Turn on Annotate, then click the preview to add notes.</p>
      ) : (
        <ul>
          {run.annotations.map((a, i) => (
            <li key={i} className="run__annotation">
              <span className="run__annotation-pos">
                ({pct(a.x)}, {pct(a.y)})
              </span>
              <span className="run__annotation-note">{a.note}</span>
              <button
                className="btn btn--ghost"
                aria-label="Remove annotation"
                onClick={() => store.removeAnnotation(i)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Clamp a value to the [0, 1] normalized range. */
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Format a normalized fraction (0–1) as a whole-percent string. */
function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
