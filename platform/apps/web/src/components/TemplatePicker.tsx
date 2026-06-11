/**
 * Task-template gallery picker (#147) for the channel composer. Lists the prebuilt marketing task
 * templates for the active channel's department; picking one pre-fills the composer with an @mention of
 * the channel's agent + the rendered brief, so sending it launches the department agent exactly like a
 * hand-typed @mention (external sends the agent drafts still go through the #13 gate).
 */
import { useEffect, useState } from "react";
import { useAppState } from "../store/StoreContext.js";
import { api } from "../api/client.js";
import type { TaskTemplateDto } from "../api/types.js";

export function TemplatePicker({ onPick }: { onPick: (text: string) => void }): React.JSX.Element | null {
  const { identity, activeChannelId } = useAppState();
  const workspaceId = identity?.workspaceId;
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TaskTemplateDto[]>([]);

  useEffect(() => {
    if (!open || !workspaceId || !activeChannelId) return;
    void api
      .getTaskTemplates(workspaceId, activeChannelId)
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, [open, workspaceId, activeChannelId]);

  if (!activeChannelId) return null;

  function pick(t: TaskTemplateDto): void {
    const mention = t.agentHandle ? `@${t.agentHandle} ` : "";
    onPick(`${mention}${t.body}`);
    setOpen(false);
  }

  return (
    <div className="composer__templates">
      <button type="button" className="btn btn--ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Templates ▾
      </button>
      {open && (
        <ul className="template-menu" role="listbox" aria-label="Task templates">
          {templates.length === 0 && <li className="muted">No templates for this channel.</li>}
          {templates.map((t) => (
            <li key={t.key}>
              <button type="button" role="option" className="template-option" onClick={() => pick(t)}>
                <span className="template-option__title">{t.title}</span>
                <span className="template-option__desc">{t.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
