/**
 * The drawer — the single "dive in" surface (console v5). Clicking any board card or session row slides
 * this in from the right. It shows the task's live step trail ("What it's doing"), a "why did it do this?"
 * link that flips in place to the receipts we actually hold (the audit trail), a composer to steer the
 * task, and — for an approval-needed task — the ask line plus an Approve / Not yet pair.
 *
 * Presentational only: the container resolves the transcript from the store's messages and the audit lines
 * from the item's real fields, so nothing here is invented. Approve / Not yet decide through the real #13
 * gate in the parent (store.decideApprove / store.decideReject) — this component just raises the intent, so
 * the gate is never weakened. The veil + slide transitions are CSS, gated by prefers-reduced-motion.
 */
import { useEffect, useState } from "react";
import { CONSOLE } from "../../brand.js";
import { StatusGlyph } from "./StatusGlyph.js";
import type { ItemKind } from "./model.js";

export interface PeekTranscriptLine {
  readonly id: string;
  readonly who: string;
  readonly body: string;
  readonly hue?: string;
  /** True for the human's own lines (rendered without the department edge). */
  readonly mine: boolean;
}

export interface PeekAuditLine {
  readonly label: string;
  readonly tag: string;
}

export interface PeekDrawerProps {
  open: boolean;
  /** Headline (the item's title). */
  title: string;
  /** Department channel name (mono kicker), or null for a non-department item. */
  dept: string | null;
  /** Owning agent's display name. */
  agent: string;
  /** Department hue for the kicker + transcript edge. */
  hue?: string;
  /** Item status (drives the status line + glyph), or null when nothing is open. */
  kind: ItemKind | null;
  /** Which face to open on: the live step trail, or the audit receipts (the board "why?" link). */
  initialMode: "steps" | "audit";
  transcript: readonly PeekTranscriptLine[];
  audit: readonly PeekAuditLine[];
  /** The approval ask line — present only for an approval-needed task. */
  askLine?: string | null;
  /** Whether the composer is shown (a shipped/audit view is still steerable as a follow-up). */
  canCompose: boolean;
  /** Whether the Approve / Not yet pair is shown (a real pending #13 request). */
  canApprove: boolean;
  /** True while this task's decision is in flight (disables the pair). */
  deciding: boolean;
  onApprove: (e: React.MouseEvent) => void;
  onReject: () => void;
  onClose: () => void;
  onSend: (text: string) => void;
}

/** The status line under the title, in the shared grammar (glyph + word). */
function statusWord(kind: ItemKind): string {
  if (kind === "waiting") return CONSOLE.peek.statusWaiting;
  if (kind === "shipped") return CONSOLE.peek.statusShipped;
  return CONSOLE.peek.statusRunning;
}

export function PeekDrawer(props: PeekDrawerProps): React.JSX.Element {
  const {
    open,
    title,
    dept,
    agent,
    hue,
    kind,
    initialMode,
    transcript,
    audit,
    askLine,
    canCompose,
    canApprove,
    deciding,
    onApprove,
    onReject,
    onClose,
    onSend,
  } = props;
  const [draft, setDraft] = useState("");
  const [showAudit, setShowAudit] = useState(initialMode === "audit");

  // A draft (and the chosen face) belong to one task. Reset whenever the drawer opens or switches tasks,
  // so steering text never leaks from one peek into the next and the "why?" view never sticks around.
  useEffect(() => {
    setDraft("");
    setShowAudit(initialMode === "audit");
  }, [title, open, initialMode]);

  function send(): void {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  }

  return (
    <>
      <div className={`peek-veil${open ? " peek-veil--show" : ""}`} onClick={onClose} aria-hidden={!open} />
      <aside className={`peek${open ? " peek--show" : ""}`} role="dialog" aria-label={title} aria-hidden={!open}>
        <header className="peek__head">
          <div className="peek__kicker">
            {dept && (
              <span className="peek__dept" style={{ color: hue ?? "var(--text-faint)" }}>
                {dept}
              </span>
            )}
            <span className="peek__agent">{agent}</span>
            <span className="peek__sp" />
            <button className="iconbtn" aria-label={CONSOLE.shell.closeSettings} onClick={onClose}>
              ✕
            </button>
          </div>
          <span className="peek__title">{title}</span>
          {kind && (
            <span className={`peek__stat peek__stat--${kind}`}>
              <StatusGlyph kind={kind} /> {statusWord(kind)}
            </span>
          )}
        </header>

        <div className="peek__body">
          {showAudit ? (
            <>
              <button className="peek__back" onClick={() => setShowAudit(false)}>
                {CONSOLE.peek.back}
              </button>
              <ul className="peek__audit">
                {audit.map((line, i) => (
                  <li key={i} className="peek__auditrow">
                    <span className="peek__auditok" aria-hidden="true">
                      ✓
                    </span>
                    <span className="peek__auditlabel">{line.label}</span>
                    <span className="peek__auditsp" />
                    <span className="peek__audittag">{line.tag}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <div className="peek__sec">{CONSOLE.peek.doing}</div>
              {transcript.length === 0 ? (
                <p className="peek__empty">{CONSOLE.peek.emptyTranscript}</p>
              ) : (
                transcript.map((m) => (
                  <div
                    key={m.id}
                    className={`peek__msg${m.mine ? "" : " peek__msg--agent"}`}
                    style={m.mine ? undefined : ({ ["--hue" as string]: m.hue ?? "var(--line)" } as React.CSSProperties)}
                  >
                    <div className="peek__who">{m.who}</div>
                    <p>{m.body}</p>
                  </div>
                ))
              )}
              <p className="peek__why">
                {CONSOLE.peek.whyHint}{" "}
                <button className="peek__whylink" onClick={() => setShowAudit(true)}>
                  {CONSOLE.peek.why}
                </button>
              </p>
            </>
          )}
        </div>

        {(canApprove || canCompose) && (
          <div className="peek__foot">
            {canApprove && (
              <>
                {askLine && <div className="peek__ask">{CONSOLE.card.askPrefix} {askLine}</div>}
                <div className="peek__approve">
                  <button className="btn peek__yes" disabled={deciding} onClick={onApprove}>
                    {CONSOLE.peek.approve}
                  </button>
                  <button className="btn btn--ghost peek__no" disabled={deciding} onClick={onReject}>
                    {CONSOLE.peek.notYet}
                  </button>
                </div>
              </>
            )}
            {canCompose && (
              <div className="peek__box">
                <textarea
                  value={draft}
                  placeholder={kind === "shipped" ? CONSOLE.peek.followUpPlaceholder : CONSOLE.peek.steerPlaceholder}
                  aria-label={CONSOLE.peek.steerPlaceholder}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Don't send mid-IME-composition (an Enter that commits a kanji/pinyin candidate).
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="peek__brow">
                  <button className="peek__send" aria-label={CONSOLE.peek.send} onClick={send}>
                    ↑
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
