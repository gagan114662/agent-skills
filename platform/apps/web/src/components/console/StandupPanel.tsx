/**
 * The left panel — Conductor's anatomy (console v5). There is no view nav anymore: the whole product is
 * two panes, and this one is pure Projects → sessions. Top: the wordmark with its idle-bob i-dot (the one
 * idle tell in the app, reused from {@link Wordmark}). Then the Projects group — each project a department
 * channel that expands with a chevron to reveal its session rows. A row wears the shared status grammar
 * (braille / vermilion dot / green dot) and a right-aligned mono meta. The ≔ filter collapses the list to
 * only-what-needs-you. The footer carries the two shell utilities (settings, sign out) and the sign-off —
 * the only home for account actions now that the top nav is gone. No brand strings are inlined.
 */
import { VOICE, CONSOLE } from "../../brand.js";
import { Wordmark } from "../Wordmark.js";
import { StatusGlyph } from "./StatusGlyph.js";
import type { ConsoleItem, ConsoleProject } from "./model.js";
import { fmtElapsed } from "./model.js";

export interface StandupPanelProps {
  projects: readonly ConsoleProject[];
  activeProjectId: string | null;
  openProjectIds: ReadonlySet<string>;
  onToggleProject: (id: string) => void;
  onSelectProject: (p: ConsoleProject) => void;
  onOpenSettings: (p: ConsoleProject) => void;
  onPeek: (item: ConsoleItem) => void;
  filterNeedsYou: boolean;
  onToggleFilter: () => void;
  activeItemKey: string | null;
  /** Shell utilities (no top nav in v5 — account actions live in the footer). */
  onOpenWorkspaceSettings: () => void;
  onSignOut: () => void;
  /** Stand up the founding team — the always-present "start a venture" control (#123/#138 seed). */
  onNewProject: () => void;
  /** True while the seed is in flight (disables the control so it can't double-fire). */
  newProjectBusy: boolean;
}

/** Right-aligned mono meta for a session row, in the status grammar. */
function rowMeta(item: ConsoleItem): React.JSX.Element {
  if (item.kind === "waiting") return <span className="sess__meta sess__meta--need">{CONSOLE.status.yourYes}</span>;
  if (item.kind === "shipped") return <span className="sess__meta sess__meta--done">{CONSOLE.status.shipped}</span>;
  return <span className="sess__meta">{item.elapsedMs !== undefined ? fmtElapsed(item.elapsedMs) : CONSOLE.status.running}</span>;
}

export function StandupPanel(props: StandupPanelProps): React.JSX.Element {
  const {
    projects,
    activeProjectId,
    openProjectIds,
    onToggleProject,
    onSelectProject,
    onOpenSettings,
    onPeek,
    filterNeedsYou,
    onToggleFilter,
    activeItemKey,
    onOpenWorkspaceSettings,
    onSignOut,
    onNewProject,
    newProjectBusy,
  } = props;

  return (
    <aside className="standup" aria-label="Standup">
      <div className="standup__top">
        <Wordmark />
      </div>

      <div className="standup__label">
        <span>{CONSOLE.projects.label}</span>
        <span className="standup__sp" />
        <button
          className="iconbtn iconbtn--mini standup__new"
          title={CONSOLE.projects.startTitle}
          aria-label={CONSOLE.projects.startTitle}
          onClick={onNewProject}
          disabled={newProjectBusy}
        >
          +
        </button>
        <button
          className={`iconbtn iconbtn--mini${filterNeedsYou ? " iconbtn--on" : ""}`}
          title={CONSOLE.projects.filterTitle}
          aria-pressed={filterNeedsYou}
          aria-label={CONSOLE.projects.filterTitle}
          onClick={onToggleFilter}
        >
          ≔
        </button>
      </div>
      <button
        className="standup__start"
        onClick={onNewProject}
        disabled={newProjectBusy}
      >
        <span className="standup__start-plus" aria-hidden="true">
          +
        </span>
        {CONSOLE.projects.start}
      </button>

      <div className="standup__plist">
        {projects.map((p) => {
          const open = openProjectIds.has(p.id) || filterNeedsYou;
          const isCurrent = p.id === activeProjectId;
          return (
            <div key={p.id} className={`proj${open ? " proj--open" : ""}${isCurrent ? " proj--current" : ""}`}>
              <div className="proj__row">
                <button
                  className="proj__main"
                  aria-expanded={open}
                  aria-current={isCurrent ? "page" : undefined}
                  aria-label={`Switch to workspace project: ${p.name}`}
                  onClick={() => {
                    onToggleProject(p.id);
                    onSelectProject(p);
                  }}
                >
                  <span className="proj__chev" aria-hidden="true">
                    ▶
                  </span>
                  <span className="proj__tile" style={{ background: p.hue }} aria-hidden="true">
                    {p.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="proj__name">{p.name}</span>
                  <span className={`proj__count${p.needsYou ? " proj__count--need" : ""}`}>
                    {p.needsYou ? p.counts.waiting : p.items.length}
                  </span>
                </button>
                <button
                  className="iconbtn iconbtn--hover"
                  title={CONSOLE.projects.settings}
                  aria-label={`${CONSOLE.projects.settings} — ${p.name}`}
                  onClick={() => onOpenSettings(p)}
                >
                  ⚙
                </button>
              </div>
              <div className="proj__sessions">
                {p.items.map((item) => {
                  const dimmed = filterNeedsYou && item.kind !== "waiting";
                  return (
                    <button
                      key={item.key}
                    className={
                        "sess" +
                        (item.kind === "waiting" ? " sess--need" : "") +
                        (item.key === activeItemKey ? " sess--active" : "") +
                        (dimmed ? " sess--dim" : "")
                      }
                      aria-current={item.key === activeItemKey ? "true" : undefined}
                      onClick={() => onPeek(item)}
                    >
                      <span className="sess__glyph">
                        <StatusGlyph kind={item.kind} />
                      </span>
                      <span className="sess__name">{item.title}</span>
                      {rowMeta(item)}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="standup__foot">
        <div className="standup__util">
          <button className="standup__utilbtn" onClick={onOpenWorkspaceSettings}>
            {CONSOLE.shell.settings}
          </button>
          <span className="standup__sp" />
          <button className="standup__utilbtn" onClick={onSignOut}>
            {CONSOLE.shell.signOut}
          </button>
        </div>
        <div className="standup__signoff">{VOICE.signOff}</div>
      </div>
    </aside>
  );
}
