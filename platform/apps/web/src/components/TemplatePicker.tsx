/**
 * Task-template gallery picker (#147) for the channel composer. Lists the prebuilt marketing task
 * templates for the active channel's department; picking one pre-fills the composer with an @mention of
 * the channel's agent + the rendered brief, so sending it launches the department agent exactly like a
 * hand-typed @mention (external sends the agent drafts still go through the #13 gate).
 *
 * #167: a template with `{{var}}` placeholders now prompts for each variable inline before it drops the
 * brief in — so the composer never receives a raw `{{site}}`. The values are substituted client-side
 * ({@link fillTemplate}); the composer's own send guard is the backstop for anything still unfilled.
 */
import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store/StoreContext.js";
import { api } from "../api/client.js";
import { VOICE } from "../brand.js";
import { fillTemplate, hasUnresolvedPlaceholders } from "../lib/templates.js";
import type { TaskTemplateDto } from "../api/types.js";

export function TemplatePicker({ onPick }: { onPick: (text: string) => void }): React.JSX.Element | null {
  const { identity, activeChannelId } = useAppState();
  const workspaceId = identity?.workspaceId;
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TaskTemplateDto[]>([]);
  // Whether we've resolved the active channel's templates at least once, so an empty channel can explain what
  // to do next instead of showing a blank dropdown.
  const [loaded, setLoaded] = useState(false);
  // The template whose variables we're currently collecting, and the values typed so far.
  const [filling, setFilling] = useState<TaskTemplateDto | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  // #474: fetch the channel's templates whenever the CHANNEL changes (not only on open) so we can hide the
  // control where none exist — and ALWAYS reset the popover, so it never sticks open over the new channel's
  // message list after a switch (the reported bug). Cancellation guards against an out-of-order resolve when
  // channels are switched quickly.
  useEffect(() => {
    setOpen(false);
    setFilling(null);
    setValues({});
    if (!workspaceId || !activeChannelId) {
      setTemplates([]);
      setLoaded(false);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    void api
      .getTaskTemplates(workspaceId, activeChannelId)
      .then((t) => {
        if (!cancelled) {
          setTemplates(t);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTemplates([]);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, activeChannelId]);

  // #474: dismiss the popover on an outside click or Escape so it never overlaps the message list after you
  // click away. Only listens while open.
  useEffect(() => {
    if (!open) return;
    function close(): void {
      setOpen(false);
      setFilling(null);
    }
    function onDown(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!activeChannelId) return null;
  /** Resolve the body with `vals`, prefix the agent @mention, and hand it to the composer. */
  function insert(t: TaskTemplateDto, vals: Record<string, string>): void {
    const mention = t.agentHandle ? `@${t.agentHandle} ` : "";
    onPick(`${mention}${fillTemplate(t.body, vals)}`);
    setOpen(false);
    setFilling(null);
    setValues({});
  }

  /** Picking a template: prompt for its variables first, or insert straight away when it has none. */
  function choose(t: TaskTemplateDto): void {
    if (t.params.length === 0) {
      insert(t, {});
      return;
    }
    setFilling(t);
    setValues(Object.fromEntries(t.params.map((p) => [p.key, ""])));
  }

  const allFilled =
    filling !== null && filling.params.every((p) => (values[p.key] ?? "").trim() !== "");

  return (
    <div className="composer__templates" ref={rootRef}>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => {
          setOpen((v) => !v);
          setFilling(null);
        }}
        aria-expanded={open}
      >
        Templates ▾
      </button>
      {open && filling && (
        <form
          className="template-fill"
          aria-label={`Fill in ${filling.title}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (allFilled) insert(filling, values);
          }}
        >
          <p className="muted">{VOICE.templateFillPrompt}</p>
          {filling.params.map((p) => (
            <label key={p.key} className="template-fill__field">
              <span>{p.label}</span>
              <input
                value={values[p.key] ?? ""}
                placeholder={p.placeholder}
                aria-label={p.label}
                onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
              />
            </label>
          ))}
          <button type="submit" className="btn btn--primary" disabled={!allFilled}>
            {VOICE.templateInsert}
          </button>
        </form>
      )}
      {open && !filling && (
        <ul className="template-menu" role="listbox" aria-label="Task templates">
          {loaded && templates.length === 0 && (
            <li className="template-menu__empty">
              Templates appear for department channels. Switch to a department channel, or write the brief
              directly in chat.
            </li>
          )}
          {templates.map((t) => (
            <li key={t.key}>
              <button type="button" role="option" className="template-option" onClick={() => choose(t)}>
                <span className="template-option__title">{t.title}</span>
                <span className="template-option__desc">{t.description}</span>
                {hasUnresolvedPlaceholders(t.body) && <span className="template-option__vars">needs details</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
