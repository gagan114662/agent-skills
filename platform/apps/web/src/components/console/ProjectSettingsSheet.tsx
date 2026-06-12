/**
 * Per-project settings sheet (General / Models / Agents / Budget / Approvals). Faithful to the brand-book
 * mockup, honest by construction: it surfaces the real values the platform actually holds (the budget
 * window + spend from #104, the named roster from the fleet, the always-on approval gate) and presents
 * the cloud model keys as write-only, sealed inputs — we never read a key back, so none is shown as a
 * fingerprint it can't prove. No fake "Save": the sheet is a configuration view (the real mutations live
 * on their own gated surfaces), so it closes with Done rather than pretending to persist (no-fake-control
 * house rule). Local model row is marked connected per the on-device default.
 */
import { useState } from "react";
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

function KeyRow({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="password" placeholder={CONSOLE.settings.models.noKey} className="field__mono" />
      <div className="field__hint">{CONSOLE.settings.models.keysHint}</div>
    </div>
  );
}

export function ProjectSettingsSheet(props: ProjectSettingsSheetProps): React.JSX.Element {
  const { open, project, budgetWindow, spentCents, budgetCents, approverEmail, onClose } = props;
  const [tab, setTab] = useState<Tab>("general");
  const name = project?.name ?? "";

  return (
    <div className={`sheet${open ? " sheet--show" : ""}`} aria-hidden={!open}>
      <div className="sheet__panel" role="dialog" aria-label={`${CONSOLE.projects.settings} — ${name}`}>
        <header className="sheet__head">
          <h2>{name}</h2>
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
                <label>{CONSOLE.settings.general.repoLabel}</label>
                <input defaultValue={name} className="field__mono" />
                <div className="field__hint">{CONSOLE.settings.general.repoHint}</div>
              </div>
              <div className="field">
                <label>{CONSOLE.settings.general.voiceLabel}</label>
                <textarea rows={3} defaultValue={CONSOLE.settings.general.voiceDefault} />
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
                </div>
              </div>
              <KeyRow label="ANTHROPIC" />
              <KeyRow label="OPENAI" />
              <KeyRow label="GOOGLE AI" />
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
