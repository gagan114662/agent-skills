/**
 * Visual workflow builder surface (#152) — the generalization of #147 automations into editable
 * trigger → condition → action chains. Lists the workspace's workflows (each rendered as a visual
 * chain), shows the run-history insights (success/failure trend), and lets the owner build a new chain,
 * toggle it, or run it now. Polled + view-local (the #104 FounderPanel pattern). Firing is default-OFF
 * on the server: a created workflow never fires until the `workflows` config is enabled, and every
 * external send an action drafts stays #13-gated (a draft_send becomes a pending approval, never a send).
 */
import { useEffect, useState } from "react";
import { useAppState } from "../../store/StoreContext.js";
import { api, ApiError } from "../../api/client.js";
import type { WorkflowDto, WorkflowInsightsDto } from "../../api/types.js";

type TriggerKind = "schedule" | "webhook" | "catalog_change" | "channel_event";
type ActionKind = "agent_task" | "draft_send" | "notify_owner";
const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "exists"] as const;

function actionSummary(a: Record<string, unknown>): string {
  switch (a.kind) {
    case "agent_task":
      return `agent task (${String(a.agentHandle ?? "agent")})`;
    case "draft_send":
      return `draft ${String(a.sendKind ?? "send")} → approval`;
    case "notify_owner":
      return "notify owner";
    default:
      return String(a.kind);
  }
}

export function WorkflowsPanel(): React.JSX.Element {
  const { identity, channels } = useAppState();
  const workspaceId = identity?.workspaceId;
  const [items, setItems] = useState<WorkflowDto[]>([]);
  const [insights, setInsights] = useState<WorkflowInsightsDto | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // builder state
  const [name, setName] = useState("");
  const [triggerKind, setTriggerKind] = useState<TriggerKind>("schedule");
  const [condFact, setCondFact] = useState("");
  const [condOp, setCondOp] = useState<(typeof OPS)[number]>("gte");
  const [condValue, setCondValue] = useState("");
  const [actionKind, setActionKind] = useState<ActionKind>("notify_owner");
  const [channelId, setChannelId] = useState("");
  const [taskOrMessage, setTaskOrMessage] = useState("");
  const [sendSummary, setSendSummary] = useState("");

  async function refresh(): Promise<void> {
    if (!workspaceId) return;
    setItems(await api.workflows.list(workspaceId));
    await api.workflows.insights(workspaceId).then(setInsights).catch(() => setInsights(null));
  }

  useEffect(() => {
    void refresh();
  }, [workspaceId]);

  function buildAction(): Record<string, unknown> | null {
    if (actionKind === "agent_task") {
      if (!channelId || !taskOrMessage.trim()) return null;
      return { kind: "agent_task", channelId, task: taskOrMessage.trim(), agentHandle: "scout" };
    }
    if (actionKind === "draft_send") {
      if (!sendSummary.trim()) return null;
      return { kind: "draft_send", sendKind: "social.post", summary: sendSummary.trim() };
    }
    return { kind: "notify_owner", message: taskOrMessage.trim() || `Workflow fired.` };
  }

  async function create(): Promise<void> {
    if (!workspaceId) return;
    if (!name.trim()) return setError("Give the workflow a name.");
    const action = buildAction();
    if (!action) return setError("Fill in the action’s fields.");
    setError(null);
    setBusy(true);
    setToken(null);
    try {
      const trigger: Record<string, unknown> = { kind: triggerKind };
      if (triggerKind === "schedule") trigger.schedule = { cadence: "daily", hour: 9, minute: 0 };
      const conditions =
        condFact.trim() && condOp
          ? [{ fact: condFact.trim(), op: condOp, ...(condOp !== "exists" ? { value: condValue } : {}) }]
          : [];
      const created = await api.workflows.create(workspaceId, {
        name: name.trim(),
        trigger,
        conditions,
        actions: [action],
        enabled: true,
      });
      if (created.webhookToken) setToken(created.webhookToken);
      setName("");
      setCondFact("");
      setCondValue("");
      setTaskOrMessage("");
      setSendSummary("");
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "could not save the workflow.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(w: WorkflowDto): Promise<void> {
    if (!workspaceId) return;
    await api.workflows.setEnabled(workspaceId, w.id, !w.enabled).catch(() => {});
    await refresh();
  }

  async function run(w: WorkflowDto): Promise<void> {
    if (!workspaceId) return;
    const result = await api.workflows.run(workspaceId, w.id).catch(() => null);
    if (result) setError(null);
    await refresh();
  }

  async function remove(w: WorkflowDto): Promise<void> {
    if (!workspaceId) return;
    await api.workflows.remove(workspaceId, w.id).catch(() => {});
    await refresh();
  }

  return (
    <div className="panel workflows-panel">
      <h2>Workflows</h2>
      <p className="panel__lede">
        Automate your fleet: when something happens, check a condition, then act. Every external send an
        action drafts still waits for your approval.
      </p>

      {insights && insights.total > 0 && (
        <div className="workflows-insights" aria-label="Run insights">
          <span className="stat">
            <strong>{Math.round(insights.successRate * 100)}%</strong> success
          </span>
          <span className="stat">
            <strong>{insights.byStatus.fired}</strong> fired
          </span>
          <span className="stat">
            <strong>{insights.byStatus.failed}</strong> failed
          </span>
          <span className="stat">
            <strong>{insights.byStatus.skipped}</strong> skipped
          </span>
        </div>
      )}

      <div className="workflow-builder" role="group" aria-label="Build a workflow">
        <input placeholder="Workflow name" aria-label="Workflow name" value={name} onChange={(e) => setName(e.target.value)} />
        <label>
          When
          <select aria-label="Trigger" value={triggerKind} onChange={(e) => setTriggerKind(e.target.value as TriggerKind)}>
            <option value="schedule">on a schedule (daily 09:00)</option>
            <option value="webhook">a webhook is called</option>
            <option value="catalog_change">the catalog changes</option>
            <option value="channel_event">a channel event</option>
          </select>
        </label>
        <fieldset className="workflow-builder__cond">
          <legend>If (optional)</legend>
          <input
            placeholder="fact e.g. catalog.site.active"
            aria-label="Condition fact"
            value={condFact}
            onChange={(e) => setCondFact(e.target.value)}
          />
          <select aria-label="Condition op" value={condOp} onChange={(e) => setCondOp(e.target.value as (typeof OPS)[number])}>
            {OPS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {condOp !== "exists" && (
            <input
              placeholder="value"
              aria-label="Condition value"
              value={condValue}
              onChange={(e) => setCondValue(e.target.value)}
            />
          )}
        </fieldset>
        <fieldset className="workflow-builder__action">
          <legend>Then</legend>
          <select aria-label="Action" value={actionKind} onChange={(e) => setActionKind(e.target.value as ActionKind)}>
            <option value="notify_owner">notify the owner</option>
            <option value="agent_task">launch an agent task</option>
            <option value="draft_send">draft an approval-gated send</option>
          </select>
          {actionKind === "agent_task" && (
            <select aria-label="Channel" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              <option value="">Choose a channel…</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          )}
          {actionKind === "draft_send" ? (
            <input
              placeholder="What should be drafted?"
              aria-label="Send summary"
              value={sendSummary}
              onChange={(e) => setSendSummary(e.target.value)}
            />
          ) : (
            <input
              placeholder={actionKind === "agent_task" ? "Task for the agent" : "Message to the owner"}
              aria-label="Action body"
              value={taskOrMessage}
              onChange={(e) => setTaskOrMessage(e.target.value)}
            />
          )}
        </fieldset>
        <button className="btn" disabled={busy} onClick={() => void create()}>
          Create workflow
        </button>
      </div>
      {error && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}
      {token && (
        <p className="panel__token">
          Webhook URL token (shown once): <code>{token}</code>
        </p>
      )}

      {items.length === 0 ? (
        <p className="panel__empty">No workflows yet. Build one above.</p>
      ) : (
        <ul className="workflow-list">
          {items.map((w) => (
            <li key={w.id} className="workflow-card">
              <div className="workflow-card__head">
                <strong>{w.name}</strong>
                <span className={`badge${w.enabled ? " badge--live" : ""}`}>{w.enabled ? "on" : "off"}</span>
              </div>
              <div className="workflow-chain" aria-label="Trigger condition action chain">
                <span className="chip chip--trigger">when: {w.triggerKind}</span>
                {w.conditions.map((c, i) => (
                  <span key={i} className="chip chip--cond">
                    if: {c.fact} {c.op} {String(c.value ?? "")}
                  </span>
                ))}
                {w.actions.map((a, i) => (
                  <span key={i} className="chip chip--action">
                    then: {actionSummary(a)}
                  </span>
                ))}
              </div>
              <div className="workflow-card__actions">
                <button className="btn btn--ghost" onClick={() => void run(w)}>
                  Run now
                </button>
                <button className="btn btn--ghost" onClick={() => void toggle(w)}>
                  {w.enabled ? "Disable" : "Enable"}
                </button>
                <button className="btn btn--ghost" aria-label={`Delete ${w.name}`} onClick={() => void remove(w)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
