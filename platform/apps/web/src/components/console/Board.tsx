/**
 * The kanban board: In motion / Waiting on you / Shipped. Each card wears its department hue as a 3px
 * left edge (the only place the hue appears as anything but a legend swatch). The Waiting lane is the
 * "different room" — it lights vermilion when live and shows the approvals-clear moment when empty.
 * Approvals decide through the real #13 gate (the parent calls store.decideApprove/decideReject); this
 * component only renders + raises intent, so no gate is weakened here.
 */
import { CONSOLE, consoleNextAsk } from "../../brand.js";
import { BrailleSpinner } from "./StatusGlyph.js";
import { fmtCents, fmtElapsed, type ConsoleItem, type ItemKind } from "./model.js";

export interface BoardProps {
  columns: Record<ItemKind, readonly ConsoleItem[]>;
  onPeek: (item: ConsoleItem) => void;
  onWhy: (item: ConsoleItem) => void;
  onApprove: (item: ConsoleItem, e: React.MouseEvent) => void;
  onReject: (item: ConsoleItem) => void;
  /** The request key currently being decided (disables its buttons). */
  decidingKey: string | null;
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

function RunningCard({ item, onPeek, onWhy }: { item: ConsoleItem } & Pick<BoardProps, "onPeek" | "onWhy">): React.JSX.Element {
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
      </div>
    </article>
  );
}

function WaitingCard({
  item,
  onPeek,
  onApprove,
  onReject,
  deciding,
}: {
  item: ConsoleItem;
  deciding: boolean;
} & Pick<BoardProps, "onPeek" | "onApprove" | "onReject">): React.JSX.Element {
  return (
    <article className="card card--need" style={hueStyle(item)}>
      <div className="card__ttl" onClick={() => onPeek(item)}>
        {item.title}
      </div>
      <div className="card__meta" onClick={() => onPeek(item)}>
        {item.meta}
        {item.amount != null && <span className="card__amount"> · {fmtCents(item.amount)}</span>}
      </div>
      <div className="card__actions">
        <button className="btn" disabled={deciding} onClick={(e) => onApprove(item, e)}>
          {CONSOLE.card.approve}
        </button>
        <button className="btn btn--ghost" disabled={deciding} onClick={() => onReject(item)}>
          {CONSOLE.card.sendBack}
        </button>
      </div>
    </article>
  );
}

function ShippedCard({ item, onPeek, onWhy }: { item: ConsoleItem } & Pick<BoardProps, "onPeek" | "onWhy">): React.JSX.Element {
  return (
    <article className="card" style={hueStyle(item)} onClick={() => onPeek(item)}>
      <div className="card__ttl">{item.title}</div>
      <div className="card__meta">{item.meta}</div>
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
  const { columns, onPeek, onWhy, onApprove, onReject, decidingKey, nextAskHint } = props;
  const waitingLive = columns.waiting.length > 0;

  return (
    <div className="board" role="list">
      <section className="board__col" role="listitem" aria-label={CONSOLE.columns.running}>
        <header className="board__colh">
          <span className="board__colt">{CONSOLE.columns.running}</span>
          <span className="board__coln">{columns.running.length}</span>
        </header>
        {columns.running.map((item) => (
          <RunningCard key={item.key} item={item} onPeek={onPeek} onWhy={onWhy} />
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
          columns.waiting.map((item) => (
            <WaitingCard
              key={item.key}
              item={item}
              onPeek={onPeek}
              onApprove={onApprove}
              onReject={onReject}
              deciding={decidingKey === item.key}
            />
          ))
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
