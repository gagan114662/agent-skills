/**
 * The left standup panel (Conductor anatomy, brand motion). Top: the wordmark with its idle-bob i-dot
 * (the one idle tell in the app, reused from {@link Wordmark}). Then the primary nav (Board / Reports /
 * History), then the Projects group — each project a department channel that expands with a chevron to
 * reveal its session rows. A row wears the shared status grammar (braille / vermilion dot / green dot)
 * and a right-aligned mono meta. The ≔ filter collapses the list to only-what-needs-you. Footer carries
 * the sign-off. No brand strings are inlined — copy comes from CONSOLE/VOICE.
 */
import { VOICE, CONSOLE } from "../../brand.js";
import { Wordmark } from "../Wordmark.js";
import { StatusGlyph } from "./StatusGlyph.js";
import type { ConsoleItem, ConsoleNav, ConsoleProject } from "./model.js";
import { fmtElapsed } from "./model.js";

export interface StandupPanelProps {
  view: ConsoleNav;
  onSelectView: (v: ConsoleNav) => void;
  projects: readonly ConsoleProject[];
  activeProjectId: string | null;
  openProjectIds: ReadonlySet<string>;
  onToggleProject: (id: string) => void;
  onSelectProject: (p: ConsoleProject) => void;
  onOpenSettings: (p: ConsoleProject) => void;
  onPeek: (item: ConsoleItem) => void;
  filterNeedsYou: boolean;
  onToggleFilter: () => void;
  /** Pending count → the Reports nav badge (the brief is where decisions live). */
  pendingCount: number;
  activeItemKey: string | null;
}

/** Right-aligned mono meta for a session row, in the status grammar. */
function rowMeta(item: ConsoleItem): React.JSX.Element {
  if (item.kind === "waiting") return <span className="sess__meta sess__meta--need">{CONSOLE.status.yourYes}</span>;
  if (item.kind === "shipped") return <span className="sess__meta sess__meta--done">{CONSOLE.status.shipped}</span>;
  return <span className="sess__meta">{item.elapsedMs !== undefined ? fmtElapsed(item.elapsedMs) : CONSOLE.status.running}</span>;
}

export function StandupPanel(props: StandupPanelProps): React.JSX.Element {
  const {
    view,
    onSelectView,
    projects,
    activeProjectId,
    openProjectIds,
    onToggleProject,
    onSelectProject,
    onOpenSettings,
    onPeek,
    filterNeedsYou,
    onToggleFilter,
    pendingCount,
    activeItemKey,
  } = props;

  return (
    <aside className="standup" aria-label="Standup">
      <div className="standup__top">
        <Wordmark />
      </div>

      <nav className="standup__nav" aria-label="Console views">
        <button
          className={`standup__navrow${view === "board" ? " standup__navrow--on" : ""}`}
          aria-pressed={view === "board"}
          onClick={() => onSelectView("board")}
        >
          {CONSOLE.nav.board}
        </button>
        <button
          className={`standup__navrow${view === "reports" ? " standup__navrow--on" : ""}`}
          aria-pressed={view === "reports"}
          onClick={() => onSelectView("reports")}
        >
          {CONSOLE.nav.reports}
          {pendingCount > 0 && <span className="standup__navcount">{pendingCount}</span>}
        </button>
        <button
          className={`standup__navrow${view === "history" ? " standup__navrow--on" : ""}`}
          aria-pressed={view === "history"}
          onClick={() => onSelectView("history")}
        >
          {CONSOLE.nav.history}
        </button>
      </nav>

      <div className="standup__label">
        <span>{CONSOLE.projects.label}</span>
        <span className="standup__sp" />
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
                  <span className="proj__count">{p.items.length}</span>
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

      <div className="standup__foot">{VOICE.signOff}</div>
    </aside>
  );
}
