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
import { useEffect, useState } from "react";
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
  // The template whose variables we're currently collecting, and the values typed so far.
  const [filling, setFilling] = useState<TaskTemplateDto | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open || !workspaceId || !activeChannelId) return;
    void api
      .getTaskTemplates(workspaceId, activeChannelId)
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, [open, workspaceId, activeChannelId]);

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
    <div className="composer__templates">
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
          {templates.length === 0 && <li className="muted">No templates for this channel.</li>}
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
