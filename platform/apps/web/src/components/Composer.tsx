/** Message composer with @mention autocomplete. Used for channel posts and (compact) thread replies. */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useStore } from "../store/StoreContext.js";
import { activeMentionQuery, applyMentionSelection } from "../store/mentions.js";
import { popConfetti } from "../lib/confetti.js";
import { hasUnresolvedPlaceholders } from "../lib/templates.js";
import { VOICE, agentColor } from "../brand.js";
import { KindBadge } from "./Primitives.js";
import { MessageQueue } from "./MessageQueue.js";
import { TemplatePicker } from "./TemplatePicker.js";
import type { MemberHit } from "../api/types.js";

/** A transient note shown under the composer: a blocked-send warning or a steer/queue confirmation. */
type Notice = { text: string; tone: "info" | "warn" };

export interface ComposerProps {
  placeholder?: string;
  /** Called with the typed text; when omitted, posts to the active channel. */
  onSubmit?: (text: string) => Promise<void> | void;
  compact?: boolean;
  /** Enable the per-session message/steering queue (#54): a Queue/Steer control + the pending list.
   * Only the channel composer opts in; thread replies stay a plain send box. */
  queue?: boolean;
  /** Bind the input to a per-channel draft (#168): when this key changes (channel switch) the visible
   * text swaps to that key's saved draft, and edits persist back to it. Omit for ephemeral composers
   * (e.g. thread replies) that shouldn't retain text across switches. */
  draftKey?: string;
  /** #509: when this changes, adopt `text` as the composer's content (focused, persisted to the draft, ready
   * to edit/send). Used by the empty-channel starter prompts to drop a suggested brief into the box. The
   * `nonce` lets the same text be re-applied on a repeat tap. */
  prefill?: { text: string; nonce: number } | null;
}

export function Composer({ placeholder, onSubmit, compact, queue, draftKey, prefill }: ComposerProps): React.JSX.Element {
  const store = useStore();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => (draftKey === undefined ? "" : store.getDraft(draftKey)));
  const [options, setOptions] = useState<MemberHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // A blocked-send hint (#167 unresolved {{vars}}) or a steer/queue confirmation. Cleared on next type.
  const [notice, setNotice] = useState<Notice | null>(null);
  // Monotonic token so a slow earlier search can't overwrite a newer query's results.
  const querySeq = useRef(0);

  // Per-channel draft restore (#168): when the bound channel changes, swap the visible text to that
  // channel's saved draft and reset the transient menu/notice so nothing leaks across the switch.
  useEffect(() => {
    if (draftKey === undefined) return;
    setText(store.getDraft(draftKey));
    setOpen(false);
    setOptions([]);
    setNotice(null);
  }, [draftKey, store]);

  // #509: a starter prompt was tapped — adopt it as the composer's text, persist it to this channel's draft
  // so a channel switch keeps it, and focus the box so the user can edit or send straight away. Keyed on the
  // nonce so tapping the same prompt twice re-applies it.
  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    if (draftKey !== undefined) store.setDraft(draftKey, prefill.text);
    setNotice(null);
    setOpen(false);
    requestAnimationFrame(() => ref.current?.focus());
    // Keyed on the nonce so a repeat tap re-applies; store/draftKey are stable for the composer's life.
  }, [prefill?.nonce]);

  async function refreshMentions(value: string, caret: number): Promise<void> {
    const seq = ++querySeq.current;
    const query = activeMentionQuery(value, caret);
    if (query === null) {
      setOpen(false);
      setOptions([]);
      return;
    }
    const hits = await store.searchMembers(query);
    if (seq !== querySeq.current) return; // a newer keystroke superseded this search
    setOptions(hits.slice(0, 8));
    setActive(0);
    setOpen(hits.length > 0);
  }

  function onChange(value: string, caret: number): void {
    setText(value);
    if (notice) setNotice(null); // typing dismisses a prior hint/confirmation
    if (draftKey !== undefined) store.setDraft(draftKey, value); // persist this channel's draft (#168)
    void refreshMentions(value, caret);
  }

  function choose(member: MemberHit): void {
    const caret = ref.current?.selectionStart ?? text.length;
    const next = applyMentionSelection(text, caret, member.displayName);
    setText(next.text);
    if (draftKey !== undefined) store.setDraft(draftKey, next.text); // keep the draft in sync (#168)
    setOpen(false);
    setOptions([]);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      }
    });
  }

  /** Returns true when the message actually went out (false when empty or blocked on an unfilled var). */
  async function submit(): Promise<boolean> {
    const value = text.trim();
    if (!value) return false;
    // Block while a template variable is still unfilled (#167) — don't ship "{{site}}" to an agent.
    if (hasUnresolvedPlaceholders(value)) {
      setNotice({ text: VOICE.unresolvedPlaceholders, tone: "warn" });
      return false;
    }
    setText("");
    if (draftKey !== undefined) store.setDraft(draftKey, ""); // a sent message clears its draft (#168)
    setOpen(false);
    setNotice(null);
    if (onSubmit) await onSubmit(value);
    else await store.sendMessage(value);
    return true;
  }

  /** Send via the button: a successful send earns a three-dot confetti pop at the button (#145 #5). */
  async function submitFromButton(e: MouseEvent<HTMLButtonElement>): Promise<void> {
    const r = e.currentTarget.getBoundingClientRect();
    const sent = await submit();
    if (sent) popConfetti(r.left + r.width / 2, r.top + r.height / 2);
  }

  /** Stack the typed text instead of sending it now. `kind` picks queue (tail) vs steer (jump ahead). */
  function stack(kind: "queue" | "steer"): void {
    const value = text.trim();
    if (!value) return;
    // Same guard as send: an unfilled {{var}} can't be steered/queued to an agent either (#167).
    if (hasUnresolvedPlaceholders(value)) {
      setNotice({ text: VOICE.unresolvedPlaceholders, tone: "warn" });
      return;
    }
    setText("");
    if (draftKey !== undefined) store.setDraft(draftKey, ""); // queued/steered text leaves the draft too (#168)
    setOpen(false);
    if (kind === "steer") store.steerMessage(value);
    else store.queueMessage(value);
    // Confirm the action so the control is never a silent no-op (#167).
    setNotice({ text: kind === "steer" ? VOICE.steerSent : VOICE.queued, tone: "info" });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (queue && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      stack("queue");
      return;
    }
    if (queue && e.key === "Enter" && e.altKey) {
      e.preventDefault();
      stack("steer");
      return;
    }
    if (open && options.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % options.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const pick = options[active];
        if (pick) choose(pick);
        return;
      }
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className={`composer${compact ? " composer--compact" : ""}`}>
      {queue && <MessageQueue />}
      {queue && (
        <TemplatePicker
          onPick={(t) => {
            setText(t);
            requestAnimationFrame(() => ref.current?.focus());
          }}
        />
      )}
      {open && options.length > 0 && (
        <ul className="mention-menu" role="listbox" aria-label="Mention a member">
          {options.map((m, i) => {
            // Agents wear their department spectrum hue (#168 #3, #145 criterion #4); humans don't tint.
            const deptColor = m.kind === "agent" ? agentColor(m.displayName) : undefined;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={`mention-option${i === active ? " mention-option--active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(m);
                  }}
                >
                  <span
                    className="mention-option__name"
                    style={deptColor ? ({ "--pop-color": deptColor } as React.CSSProperties) : undefined}
                  >
                    {m.displayName}
                  </span>
                  <KindBadge kind={m.kind} color={deptColor} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="composer__row">
        <textarea
          ref={ref}
          className="composer__input"
          value={text}
          placeholder={placeholder ?? "Message — type @ to mention a teammate or agent"}
          rows={compact ? 1 : 2}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
        />
        {queue && (
          <>
            <button
              className="btn btn--ghost"
              type="button"
              onClick={() => stack("queue")}
              aria-label={VOICE.queueTooltip}
              title={VOICE.queueTooltip}
            >
              Queue
            </button>
            <button
              className="btn btn--ghost"
              type="button"
              onClick={() => stack("steer")}
              aria-label={VOICE.steerTooltip}
              title={VOICE.steerTooltip}
            >
              Steer
            </button>
          </>
        )}
        <button
          className="btn btn--primary"
          type="button"
          onClick={(e) => void submitFromButton(e)}
          aria-label="Send"
        >
          Send
        </button>
      </div>
      {notice && (
        <div
          className={`composer__notice composer__notice--${notice.tone}`}
          role={notice.tone === "warn" ? "alert" : "status"}
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}
