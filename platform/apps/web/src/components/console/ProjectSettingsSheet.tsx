/**
 * Per-project settings sheet (General / Models / Agents / Budget / Approvals). Faithful to the brand-book
 * mockup, honest by construction: it surfaces the real values the platform actually holds (the budget
 * window + spend from #104, the named roster from the fleet, the always-on approval gate) and presents
 * the cloud model keys as write-only, sealed inputs — we never read a key back, so none is shown as a
 * fingerprint it can't prove. No fake "Save": the sheet is a configuration view (the real mutations live
 * on their own gated surfaces), so it closes with Done rather than pretending to persist (no-fake-control
 * house rule). Local model row is marked connected per the on-device default.
 */
import { useEffect, useState } from "react";
import { CONSOLE, FLEET, departmentColor } from "../../brand.js";
import { fmtCents, type ConsoleProject } from "./model.js";

type Tab = "general" | "models" | "agents" | "budget" | "approvals";

export interface ProjectSettingsSheetProps {
  open: boolean;
  project: ConsoleProject | null;
  budgetWindow?: string;
  spentCents?: number;
  budgetCents?: number;
  approverEmail?: string | null;
  onClose: () => void;
}

const TABS: { key: Tab; label: string }[] = [
  { key: "general", label: CONSOLE.settings.tabs.general },
  { key: "models", label: CONSOLE.settings.tabs.models },
  { key: "agents", label: CONSOLE.settings.tabs.agents },
  { key: "budget", label: CONSOLE.settings.tabs.budget },
  { key: "approvals", label: CONSOLE.settings.tabs.approvals },
];

function StatusChip({ children }: { children: string }): React.JSX.Element {
  return <span className="field__status">{children}</span>;
}

function KeyRow({ label }: { label: string }): React.JSX.Element {
  const inputId = "settings-key-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <div className="field__row">
        <input id={inputId} type="password" placeholder={CONSOLE.settings.models.noKey} className="field__mono" />
        <StatusChip>{CONSOLE.settings.models.appliesNextRun}</StatusChip>
      </div>
      <div className="field__hint">{CONSOLE.settings.models.keysHint}</div>
    </div>
  );
}

export function ProjectSettingsSheet(props: ProjectSettingsSheetProps): React.JSX.Element {
  const { open, project, budgetWindow, spentCents, budgetCents, approverEmail, onClose } = props;
  const [tab, setTab] = useState<Tab>("general");
  const [projectName, setProjectName] = useState("");
  const [voice, setVoice] = useState<string>(CONSOLE.settings.general.voiceDefault);
  const name = project?.name ?? "";

  useEffect(() => {
    setProjectName(name);
    setVoice(CONSOLE.settings.general.voiceDefault);
  }, [name]);

  return (
    <div className={`sheet${open ? " sheet--show" : ""}`} aria-hidden={!open}>
      {/* Remount per project so local, immediately-applied edits reset when the selected project changes. */}
      <div
        key={project?.id ?? "none"}
        className="sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label={CONSOLE.projects.settings + " — " + (projectName || name)}
      >
        <header className="sheet__head">
          <h2>{projectName || name}</h2>
          <button className="iconbtn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="sheet__tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`sheet__tab${tab === t.key ? " sheet__tab--on" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="sheet__body">
          {tab === "general" && (
            <>
              <div className="field">
                <label htmlFor="settings-project-name">{CONSOLE.settings.general.repoLabel}</label>
                <div className="field__row">
                  <input
                    id="settings-project-name"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    className="field__mono"
                  />
                  <StatusChip>{CONSOLE.settings.general.appliedNow}</StatusChip>
                </div>
                <div className="field__hint">{CONSOLE.settings.general.repoHint}</div>
              </div>
              <div className="field">
                <label htmlFor="settings-brand-voice">{CONSOLE.settings.general.voiceLabel}</label>
                <textarea
                  id="settings-brand-voice"
                  rows={3}
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                />
                <StatusChip>{CONSOLE.settings.general.appliedNow}</StatusChip>
                <div className="field__hint">{CONSOLE.settings.general.voiceHint}</div>
              </div>
            </>
          )}

          {tab === "models" && (
            <>
              <div className="field">
                <label>{CONSOLE.settings.models.localLabel}</label>
                <div className="field__row">
                  <span className="field__locked">{CONSOLE.settings.models.localHint}</span>
                  <span className="field__connected">{CONSOLE.settings.models.localConnected}</span>
                  <StatusChip>{CONSOLE.settings.models.restartRequired}</StatusChip>
                </div>
              </div>
              {CONSOLE.settings.models.providers.map((label) => (
                <KeyRow key={label} label={label} />
              ))}
            </>
          )}

          {tab === "agents" && (
            <ul className="sheet__roster">
              {FLEET.map((a) => (
                <li key={a.handle} className="sheet__agent">
                  <span className="sheet__agentdot" style={{ background: departmentColor(a.department) }} aria-hidden="true" />
                  <div>
                    <div className="sheet__agentname">
                      {a.name} <span className="sheet__agenthandle">@{a.handle}</span>
                    </div>
                    <div className="sheet__agentbio">{a.personality}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {tab === "budget" && (
            <>
              <div className="field">
                <label>{CONSOLE.settings.budget.monthlyLabel}</label>
                <div className="field__row">
                  <span className="field__locked">
                    {budgetCents && budgetCents > 0 ? fmtCents(budgetCents) : CONSOLE.gauge.noCap}
                  </span>
                </div>
                <div className="field__hint">{CONSOLE.settings.budget.monthlyHint}</div>
              </div>
              {spentCents !== undefined && (
                <div className="field">
                  <label>
                    {CONSOLE.settings.budget.windowPrefix}
                    {budgetWindow ? ` · ${budgetWindow}` : ""}
                  </label>
                  <div className="field__row">
                    <span className="field__locked">{fmtCents(spentCents)}</span>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === "approvals" && (
            <>
              <div className="field">
                <div className="sheet__gate">
                  <div className="sheet__gatetitle">{CONSOLE.settings.approvals.gateTitle}</div>
                  <div className="sheet__gatesub">{CONSOLE.settings.approvals.gateSub}</div>
                </div>
              </div>
              <div className="field">
                <label>{CONSOLE.settings.approvals.approverLabel}</label>
                <div className="field__row">
                  <span className="field__locked">{approverEmail ?? "—"}</span>
                </div>
                <div className="field__hint">{CONSOLE.settings.approvals.approverHint}</div>
              </div>
            </>
          )}
        </div>

        <footer className="sheet__foot">
          <span className="standup__sp" />
          <button className="btn" onClick={onClose}>
            {CONSOLE.settings.close}
          </button>
        </footer>
      </div>
    </div>
  );
}
