/**
 * The peek drawer — a right slide-over that opens any session with its full transcript and a composer to
 * steer it, or the "why?" audit trail (the receipts we actually hold for an item). Presentational: the
 * container resolves the transcript from the store's messages and the audit lines from the item's real
 * fields, so nothing here is invented. The veil + drawer transitions are CSS, gated by reduced motion.
 */
import { useState } from "react";
import { CONSOLE } from "../../brand.js";

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
  title: string;
  status: string;
  mode: "transcript" | "audit";
  transcript: readonly PeekTranscriptLine[];
  audit: readonly PeekAuditLine[];
  /** Whether the composer is shown (a shipped/auditing view is read-only). */
  canCompose: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
}

export function PeekDrawer(props: PeekDrawerProps): React.JSX.Element {
  const { open, title, status, mode, transcript, audit, canCompose, onClose, onSend } = props;
  const [draft, setDraft] = useState("");

  function send(): void {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  }

  return (
    <>
      <div className={`peek-veil${open ? " peek-veil--show" : ""}`} onClick={onClose} aria-hidden={!open} />
      <aside
        className={`peek${open ? " peek--show" : ""}`}
        role="dialog"
        aria-label={title}
        aria-hidden={!open}
      >
        <header className="peek__head">
          <span className="peek__title">{title}</span>
          <span className="peek__status">{status}</span>
          <button className="iconbtn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="peek__body">
          {mode === "audit" ? (
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
          ) : transcript.length === 0 ? (
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
        </div>

        {canCompose && (
          <div className="peek__compose">
            <div className="peek__box">
              <textarea
                value={draft}
                placeholder={CONSOLE.peek.steerPlaceholder}
                aria-label={CONSOLE.peek.steerPlaceholder}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
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
          </div>
        )}
      </aside>
    </>
  );
}
