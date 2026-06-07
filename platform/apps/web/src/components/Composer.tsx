/** Message composer with @mention autocomplete. Used for channel posts and (compact) thread replies. */
import { useRef, useState, type KeyboardEvent } from "react";
import { useStore } from "../store/StoreContext.js";
import { activeMentionQuery, applyMentionSelection } from "../store/mentions.js";
import { KindBadge } from "./Primitives.js";
import type { MemberHit } from "../api/types.js";

export interface ComposerProps {
  placeholder?: string;
  /** Called with the typed text; when omitted, posts to the active channel. */
  onSubmit?: (text: string) => Promise<void> | void;
  compact?: boolean;
}

export function Composer({ placeholder, onSubmit, compact }: ComposerProps): React.JSX.Element {
  const store = useStore();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [options, setOptions] = useState<MemberHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Monotonic token so a slow earlier search can't overwrite a newer query's results.
  const querySeq = useRef(0);

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
    void refreshMentions(value, caret);
  }

  function choose(member: MemberHit): void {
    const caret = ref.current?.selectionStart ?? text.length;
    const next = applyMentionSelection(text, caret, member.displayName);
    setText(next.text);
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

  async function submit(): Promise<void> {
    const value = text.trim();
    if (!value) return;
    setText("");
    setOpen(false);
    if (onSubmit) await onSubmit(value);
    else await store.sendMessage(value);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
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
      {open && options.length > 0 && (
        <ul className="mention-menu" role="listbox" aria-label="Mention a member">
          {options.map((m, i) => (
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
                <span className="mention-option__name">{m.displayName}</span>
                <KindBadge kind={m.kind} />
              </button>
            </li>
          ))}
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
        <button className="btn btn--primary" type="button" onClick={() => void submit()} aria-label="Send">
          Send
        </button>
      </div>
    </div>
  );
}
