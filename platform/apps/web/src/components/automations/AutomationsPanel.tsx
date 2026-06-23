/**
 * Automations surface (#147) — list the workspace's scheduled/webhook agent tasks and define new ones
 * from the task-template gallery. Polled + view-local (the #104 FounderPanel pattern), so it stays out
 * of the realtime store. Default-OFF on the server: a created automation never fires until the
 * `automations` config is enabled, and every external send the launched agent drafts stays #13-gated.
 */
import { useEffect, useRef, useState } from "react";
import { useAppState } from "../../store/StoreContext.js";
import { api, ApiError } from "../../api/client.js";
import { VOICE } from "../../brand.js";
import type { AutomationDto, TaskTemplateDto } from "../../api/types.js";

type Cadence = "interval" | "hourly" | "daily" | "weekly";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function AutomationsPanel(): React.JSX.Element {
  const { identity, channels } = useAppState();
  const workspaceId = identity?.workspaceId;
  const [items, setItems] = useState<AutomationDto[]>([]);
  const [templates, setTemplates] = useState<TaskTemplateDto[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Brand-voice validation/server error shown under the form (#167). null = no error.
  const [error, setError] = useState<string | null>(null);

  // form state
  const [name, setName] = useState("");
  const [channelId, setChannelId] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [triggerKind, setTriggerKind] = useState<"schedule" | "webhook">("schedule");
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [everyMinutes, setEveryMinutes] = useState(60);
  const nameInputRef = useRef<HTMLInputElement>(null);

  async function refresh(): Promise<void> {
    if (!workspaceId) return;
    setItems(await api.automations.list(workspaceId));
  }

  useEffect(() => {
    void refresh();
  }, [workspaceId]);

  // templates follow the selected channel's department.
  useEffect(() => {
    if (!workspaceId || !channelId) {
      setTemplates([]);
      return;
    }
    void api.getTaskTemplates(workspaceId, channelId).then(setTemplates).catch(() => setTemplates([]));
  }, [workspaceId, channelId]);

  async function create(): Promise<void> {
    if (!workspaceId) return;
    // Validate up front in brand voice — the old guard returned silently, so Create looked dead (#167).
    if (!name.trim()) return setError(VOICE.automationNeedsName);
    if (!channelId) return setError(VOICE.automationNeedsChannel);
    if (!templateKey) return setError(VOICE.automationNeedsTemplate);
    setError(null);
    setBusy(true);
    setToken(null);
    try {
      const schedule =
        triggerKind === "schedule"
          ? cadence === "interval"
            ? { cadence, everyMinutes }
            : cadence === "hourly"
              ? { cadence, minute }
              : cadence === "daily"
                ? { cadence, hour, minute }
                : { cadence, dayOfWeek, hour, minute }
          : undefined;
      const created = await api.automations.create(workspaceId, {
        name: name.trim(),
        channelId,
        templateKey,
        triggerKind,
        schedule,
        enabled: true,
      });
      if (created.webhookToken) setToken(created.webhookToken);
      setName("");
      await refresh();
    } catch (e) {
      // Surface the failure instead of swallowing it (the route 400s were invisible before #167).
      const reason = e instanceof ApiError ? e.message : "please try again.";
      setError(`${VOICE.automationCreateFailed} ${reason}`);
    } finally {
      setBusy(false);
    }
  }

  async function run(id: string): Promise<void> {
    if (!workspaceId) return;
    const r = await api.automations.run(workspaceId, id);
    await refresh();
    alert(`Run ${r.status}${r.reason ? ` (${r.reason})` : ""}`);
  }

  async function toggle(a: AutomationDto): Promise<void> {
    if (!workspaceId) return;
    await api.automations.setEnabled(workspaceId, a.id, !a.enabled);
    await refresh();
  }

  async function remove(id: string): Promise<void> {
    if (!workspaceId) return;
    await api.automations.remove(workspaceId, id);
    await refresh();
  }

  return (
    <div className="workspace__panel automations">
      <h2>Automations</h2>
      <p className="muted">
        Repeatable agent tasks on a schedule or webhook. Tasks run through the same gated path as a human
        @mention — external sends still need approval.
      </p>

      <div className="automations__form">
        <input
          ref={nameInputRef}
          placeholder="Name (e.g. Monday SEO audit)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          <option value="">Channel…</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
        <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} disabled={!channelId}>
          <option value="">Template…</option>
          {templates.map((t) => (
            <option key={t.key} value={t.key}>
              {t.title}
            </option>
          ))}
        </select>
        <select value={triggerKind} onChange={(e) => setTriggerKind(e.target.value as "schedule" | "webhook")}>
          <option value="schedule">Schedule</option>
          <option value="webhook">Webhook</option>
        </select>
        {triggerKind === "schedule" && (
          <>
            <select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
              <option value="weekly">Weekly</option>
              <option value="daily">Daily</option>
              <option value="hourly">Hourly</option>
              <option value="interval">Every N min</option>
            </select>
            {cadence === "weekly" && (
              <select value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}>
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            )}
            {cadence === "interval" ? (
              <input
                type="number"
                min={1}
                value={everyMinutes}
                onChange={(e) => setEveryMinutes(Number(e.target.value))}
                aria-label="every minutes"
              />
            ) : (
              <>
                {cadence !== "hourly" && (
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={hour}
                    onChange={(e) => setHour(Number(e.target.value))}
                    aria-label="hour"
                  />
                )}
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={minute}
                  onChange={(e) => setMinute(Number(e.target.value))}
                  aria-label="minute"
                />
              </>
            )}
          </>
        )}
        <button className="btn btn--primary" disabled={busy} onClick={() => void create()}>
          Create
        </button>
      </div>

      {error && (
        <div className="automations__error" role="alert">
          {error}
        </div>
      )}

      {token && (
        <div className="automations__token" role="status">
          Webhook URL (shown once): <code>POST /automations/hooks/{token}</code>
        </div>
      )}

      <ul className="automations__list">
        {items.length === 0 && (
          <li className="panel__empty panel__empty--action">
            <p>Automations appear here after you choose a channel, template, and schedule.</p>
            <button className="btn btn--primary" type="button" onClick={() => nameInputRef.current?.focus()}>
              Name an automation
            </button>
          </li>
        )}
        {items.map((a) => (
          <li key={a.id} className="automations__item">
            <div>
              <strong>{a.name}</strong> <span className="badge">{a.triggerKind}</span>{" "}
              <span className="muted">@{a.agentHandle}</span>
              <div className="muted">
                {a.templateKey}
                {a.nextRunAt ? ` · next ${new Date(a.nextRunAt).toLocaleString()}` : ""}
              </div>
            </div>
            <div className="automations__actions">
              <button className="btn btn--ghost" onClick={() => void run(a.id)}>
                Run now
              </button>
              <button className="btn btn--ghost" onClick={() => void toggle(a)}>
                {a.enabled ? "Pause" : "Enable"}
              </button>
              <button className="btn btn--ghost" onClick={() => void remove(a.id)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
