/**
 * The hero's full workspace simulation (#165) — the landing's centrepiece. An illustrative, faithful
 * SAMPLE render of the ipop console built from static `brand.ts` data (labelled "sample" in the title bar
 * and aria-label so it is never mistaken for a live feed — de-theater audit). On the left, the sidebar (pinned
 * channels, every department channel coloured from the spectrum, and DMs, with the ⌘K search). On the
 * right, a whole day's timeline in #seo that auto-plays one entry at a time and loops — a brief, an
 * audit with receipts, a draft, a QA pass, an approval card, the human's "ship it", a queued send, and
 * the end-of-day numbers.
 *
 * Every entry is always in the DOM (so crawlers and assistive tech see the whole story); the reveal is a
 * visual `is-shown` class driven by {@link useStagedReveal}. Under prefers-reduced-motion the whole day
 * shows at once and nothing animates. All copy comes from `brand.ts` (no hardcoded strings — brand.test
 * scans this file); all colours come from {@link DEPARTMENT_SPECTRUM}.
 */
import { BRAND, DEPARTMENT_SPECTRUM, FLEET, WORKSPACE, type Dept, type SimEntry } from "../../brand.js";
import { usePrefersReducedMotion, useStagedReveal } from "./useReducedMotion.js";

const STEP_MS = 1500;
const NAME_BY_HANDLE = new Map(FLEET.map((a) => [a.handle, a.name]));

function deptColor(dept: Dept | undefined): string | undefined {
  return dept ? DEPARTMENT_SPECTRUM[dept] : undefined;
}

function speakerName(from: string): string {
  return from === "you" ? "you" : (NAME_BY_HANDLE.get(from) ?? from);
}

/** Initials chip for a human DM row (e.g. "Priya (you)" → "P"). */
function initials(name: string): string {
  return name.trim().charAt(0).toUpperCase();
}

export function WorkspaceSim(): React.JSX.Element {
  const reduced = usePrefersReducedMotion();
  const shown = useStagedReveal(WORKSPACE.timeline.length, STEP_MS, reduced);

  return (
    <div className="simwin" role="img" aria-label={`A sample look inside the ${BRAND.name} workspace`}>
      <div className="simwin__chrome" aria-hidden="true">
        <span className="simwin__dot simwin__dot--r" />
        <span className="simwin__dot simwin__dot--y" />
        <span className="simwin__dot simwin__dot--g" />
        <span className="simwin__title">{WORKSPACE.workspaceName}</span>
      </div>
      <div className="simwin__body">
        <Sidebar />
        <ChannelView shown={shown} />
      </div>
    </div>
  );
}

function Sidebar(): React.JSX.Element {
  return (
    <aside className="sim-sidebar" aria-label="Workspace channels">
      <div className="sim-sidebar__search" aria-hidden="true">
        <span className="sim-sidebar__search-text">{WORKSPACE.searchPlaceholder}</span>
        <kbd className="sim-sidebar__kbd">{WORKSPACE.searchHint}</kbd>
      </div>
      {WORKSPACE.sidebar.map((section) => (
        <div key={section.title} className="sim-sidebar__section">
          <p className="sim-sidebar__heading">{section.title}</p>
          <ul className="sim-sidebar__list">
            {section.items.map((item) => {
              const color = deptColor(item.dept);
              return (
                <li
                  key={item.name}
                  className={`sim-sidebar__item${item.active ? " is-active" : ""}`}
                >
                  {item.kind === "human" ? (
                    <span className="sim-sidebar__avatar" aria-hidden="true">
                      {initials(item.name)}
                    </span>
                  ) : (
                    <span
                      className="sim-sidebar__bullet"
                      style={{ background: color ?? "var(--text-faint)" }}
                      aria-hidden="true"
                    />
                  )}
                  <span className="sim-sidebar__name">{item.name}</span>
                  {item.unread ? (
                    <span className="sim-sidebar__unread">{item.unread}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </aside>
  );
}

function ChannelView({ shown }: { shown: number }): React.JSX.Element {
  return (
    <section className="sim-channel" aria-label={`Channel ${WORKSPACE.activeChannel}`}>
      <header className="sim-channel__header">
        <h3 className="sim-channel__name">{WORKSPACE.activeChannel}</h3>
        <p className="sim-channel__topic">{WORKSPACE.activeChannelTopic}</p>
      </header>
      <ol className="sim-channel__feed">
        {WORKSPACE.timeline.map((entry, i) => (
          <Entry key={i} entry={entry} shown={i < shown} />
        ))}
      </ol>
    </section>
  );
}

function Entry({ entry, shown }: { entry: SimEntry; shown: boolean }): React.JSX.Element {
  return (
    <li className={`sim-entry${shown ? " is-shown" : ""}`}>
      {entry.kind === "message" && <MessageEntry entry={entry} shown={shown} />}
      {entry.kind === "task" && <TaskCard entry={entry} />}
      {entry.kind === "qa" && <QaResult entry={entry} />}
      {entry.kind === "approval" && <ApprovalCard entry={entry} />}
    </li>
  );
}

function MessageEntry({
  entry,
  shown,
}: {
  entry: Extract<SimEntry, { kind: "message" }>;
  shown: boolean;
}): React.JSX.Element {
  const isYou = entry.from === "you";
  const color = deptColor(entry.dept);
  return (
    <div className={`sim-msg${isYou ? " sim-msg--you" : ""}`}>
      <span
        className="sim-msg__avatar"
        style={{ background: isYou ? "var(--ink)" : (color ?? "var(--text-faint)") }}
        aria-hidden="true"
      />
      <div className="sim-msg__body">
        <p className="sim-msg__meta">
          <span className="sim-msg__who" style={color ? { color } : undefined}>
            {speakerName(entry.from)}
          </span>
          <span className="sim-msg__time">{entry.time}</span>
        </p>
        <p className="sim-msg__text">{entry.text}</p>
        {entry.thread && <span className="sim-msg__thread">{entry.thread}</span>}
        {entry.done && shown && (
          <span className="sim-msg__confetti confetti" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        )}
      </div>
    </div>
  );
}

function TaskCard({ entry }: { entry: Extract<SimEntry, { kind: "task" }> }): React.JSX.Element {
  const color = deptColor(entry.dept);
  return (
    <div className="sim-task" style={color ? { ["--dept" as string]: color } : undefined}>
      <div className="sim-task__top">
        <span className="sim-task__id">{entry.id}</span>
        <span className="sim-task__status">{entry.status}</span>
      </div>
      <p className="sim-task__title">{entry.title}</p>
      <p className="sim-task__assignee">
        <span className="sim-task__bullet" style={{ background: color }} aria-hidden="true" />
        {entry.assignee} · {entry.time}
      </p>
    </div>
  );
}

function QaResult({ entry }: { entry: Extract<SimEntry, { kind: "qa" }> }): React.JSX.Element {
  const color = deptColor(entry.dept);
  return (
    <div className="sim-qa" style={color ? { ["--dept" as string]: color } : undefined}>
      <p className="sim-qa__head">
        <span className="sim-qa__check" aria-hidden="true">
          ✓
        </span>
        <span className="sim-qa__count">
          {entry.passed}/{entry.total} checks passing
        </span>
        <span className="sim-qa__by">
          {entry.from} · {entry.time}
        </span>
      </p>
      <p className="sim-qa__note">{entry.note}</p>
    </div>
  );
}

function ApprovalCard({
  entry,
}: {
  entry: Extract<SimEntry, { kind: "approval" }>;
}): React.JSX.Element {
  const color = deptColor(entry.dept);
  return (
    <div className="sim-approval" style={color ? { ["--dept" as string]: color } : undefined}>
      <div className="sim-approval__top">
        <span className="sim-approval__tag">{entry.pendingLabel}</span>
        <span className="sim-approval__time">{entry.time}</span>
      </div>
      <p className="sim-approval__title">{entry.title}</p>
      <p className="sim-approval__detail">{entry.detail}</p>
      <div className="sim-approval__actions" aria-hidden="true">
        <span className="sim-approval__btn sim-approval__btn--no">{entry.rejectLabel}</span>
        <span className="sim-approval__btn sim-approval__btn--yes">{entry.approveLabel}</span>
      </div>
      <p className="sim-approval__decided">
        <span className="sim-approval__decided-tag">{entry.decidedLabel}</span>
        <span className="sim-approval__reply">{entry.reply}</span>
      </p>
    </div>
  );
}
