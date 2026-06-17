/**
 * The kanban — exactly three columns (console v5): Work in progress / Spend approval / Done. Each card
 * wears its department hue as a 3px left edge (the only place the hue ever appears; never a filled shape).
 * Every card opens the drawer to dive in. The Spend-approval lane is the "different room" — it holds only
 * money decisions (#243), lights vermilion when live, shows the approvals-clear moment when empty; its
 * cards carry the ask line and
 * open into the drawer, where Approve / Not yet decide through the real #13 gate. This component only
 * renders + raises intent (onPeek / onWhy / onStop), so no gate is weakened here. The running card
 * carries a Stop control (#248) so the owner can kill a runaway agent without leaving the board.
 */
import { CONSOLE, consoleNextAsk } from "../../brand.js";
import { BrailleSpinner } from "./StatusGlyph.js";
import { fmtCents, fmtElapsed, type ConsoleItem, type ItemKind } from "./model.js";

export interface BoardProps {
  columns: Record<ItemKind, readonly ConsoleItem[]>;
  onPeek: (item: ConsoleItem) => void;
  onWhy: (item: ConsoleItem) => void;
  /** #248: stop a running session from its card. Absent → no Stop control (back-compat). */
  onStop?: (item: ConsoleItem) => void;
  /** Optional "next likely ask" hint for the empty-approvals moment. */
  nextAskHint?: string;
}

function hueStyle(item: ConsoleItem): React.CSSProperties {
  return { ["--hue" as string]: item.hue ?? "var(--line)" } as React.CSSProperties;
}

function Why({ item, onWhy }: { item: ConsoleItem; onWhy: (i: ConsoleItem) => void }): React.JSX.Element {
  return (
    <button
      className="card__why"
      onClick={(e) => {
        e.stopPropagation();
        onWhy(item);
      }}
    >
      {CONSOLE.card.why}
    </button>
  );
}

function RunningCard({
  item,
  onPeek,
  onWhy,
  onStop,
}: { item: ConsoleItem } & Pick<BoardProps, "onPeek" | "onWhy" | "onStop">): React.JSX.Element {
  return (
    <article className="card" style={hueStyle(item)} onClick={() => onPeek(item)}>
      <div className="card__ttl">
        <BrailleSpinner /> {item.title}
      </div>
      <div className="card__meta">{item.meta}</div>
      <div className="card__foot">
        {item.costCents !== undefined && <span>{fmtCents(item.costCents)}</span>}
        <Why item={item} onWhy={onWhy} />
        <span className="card__sp" />
        {item.elapsedMs !== undefined && <span>{fmtElapsed(item.elapsedMs)}</span>}
        {onStop && (
          <button
            className="card__stop"
            aria-label={`${CONSOLE.card.stop} ${item.agentLabel}`}
            onClick={(e) => {
              e.stopPropagation();
              onStop(item);
            }}
          >
            {CONSOLE.card.stop}
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * Approval-needed card. A human title, an optional preview of what the agent produced, and a clear
 * "what happens if I approve" line (#302) — never the raw agent prompt or the `agent.deliverable` type id.
 * Clicking dives into the drawer to Approve / Not yet.
 */
function WaitingCard({ item, onPeek }: { item: ConsoleItem } & Pick<BoardProps, "onPeek">): React.JSX.Element {
  return (
    <article className="card card--need" style={hueStyle(item)} onClick={() => onPeek(item)}>
      <div className="card__ttl">{item.title}</div>
      {item.preview && <div className="card__preview">{item.preview}</div>}
      <div className="card__ask">
        {CONSOLE.card.askPrefix} {item.consequence ?? item.meta}
        {item.amount != null && <span className="card__amount"> · {fmtCents(item.amount)}</span>}
      </div>
    </article>
  );
}

function ShippedCard({ item, onPeek, onWhy }: { item: ConsoleItem } & Pick<BoardProps, "onPeek" | "onWhy">): React.JSX.Element {
  return (
    <article className="card" style={hueStyle(item)} onClick={() => onPeek(item)}>
      <div className="card__ttl">{item.title}</div>
      <div className="card__meta">{item.preview || item.meta}</div>
      <div className="card__foot">
        {item.amount != null && <span className="card__a">{fmtCents(item.amount)}</span>}
        <Why item={item} onWhy={onWhy} />
        <span className="card__sp" />
        <span>{CONSOLE.status.shipped}</span>
      </div>
    </article>
  );
}

export function Board(props: BoardProps): React.JSX.Element {
  const { columns, onPeek, onWhy, onStop, nextAskHint } = props;
  const waitingLive = columns.waiting.length > 0;

  return (
    <div className="board" role="list">
      <section className="board__col" role="listitem" aria-label={CONSOLE.columns.running}>
        <header className="board__colh">
          <span className="board__colt">{CONSOLE.columns.running}</span>
          <span className="board__coln">{columns.running.length}</span>
        </header>
        {columns.running.map((item) => (
          <RunningCard key={item.key} item={item} onPeek={onPeek} onWhy={onWhy} onStop={onStop} />
        ))}
      </section>

      <section
        className={`board__col${waitingLive ? " board__col--live" : ""}`}
        role="listitem"
        aria-label={CONSOLE.columns.waiting}
      >
        <header className="board__colh board__colh--hot">
          {waitingLive && <i className="board__pulse" aria-hidden="true" />}
          <span className="board__colt">{CONSOLE.columns.waiting}</span>
          <span className="board__coln">{columns.waiting.length}</span>
        </header>
        {waitingLive ? (
          columns.waiting.map((item) => <WaitingCard key={item.key} item={item} onPeek={onPeek} />)
        ) : (
          <div className="board__clear" role="status">
            <b>{CONSOLE.approvalsClear.headline}</b>
            <span>{consoleNextAsk(nextAskHint)}</span>
          </div>
        )}
      </section>

      <section className="board__col" role="listitem" aria-label={CONSOLE.columns.shipped}>
        <header className="board__colh">
          <span className="board__colt">{CONSOLE.columns.shipped}</span>
          <span className="board__coln">{columns.shipped.length}</span>
        </header>
        {columns.shipped.map((item) => (
          <ShippedCard key={item.key} item={item} onPeek={onPeek} onWhy={onWhy} />
        ))}
      </section>
    </div>
  );
}
