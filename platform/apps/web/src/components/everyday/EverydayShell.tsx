/**
 * The everyday workspace shell (#784) — the linzumi-calm, chat-first redesign of the logged-in surface.
 * Near-black canvas, ONE coral pop used sparingly, Instrument Serif headlines + Inter body, generous
 * whitespace. The layout is the surface map from the issue, top to bottom:
 *
 *   · NORTH STAR — paying customers + revenue, front and centre (#630).
 *   · THREAD — a calm chat where deliverables, drafts and before/after diffs land INLINE (#572/#574).
 *   · APPROVAL QUEUE — one-glance ship decisions showing the FINISHED deliverable, never internal chatter
 *     (#572/#574/#632); the only hard gate is money.
 *   · TRANSPARENCY LOG — every external action, timestamped + linked (#629).
 *   · SAFETY — money gate + an always-on kill switch, framed as reassurance, not config.
 *
 * Copy-free by house rule: every product word comes from EVERYDAY/VOICE in brand.ts; only agent output and
 * deliverable bodies (genuine work product) come through as data. Gated + owner-first via the everyday-shell
 * flag, so production renders today's console unchanged.
 */
import { useState } from "react";
import { EVERYDAY } from "../../brand.js";
import {
  type ApprovalCard,
  type Deliverable,
  type EverydayData,
  type ExternalAction,
  type NorthStar,
  type ThreadEntry,
  compactCount,
  partOfDay,
  seedEveryday,
  signedDelta,
} from "./everyday-data.js";

/** A small agent monogram tile — first initial, used through the thread + cards so agents feel like people. */
function AgentChip({ name }: { name: string }): React.JSX.Element {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span className="everyday-agent" aria-hidden="true">
      {initial}
    </span>
  );
}

/** The north star: customers + revenue, the only scoreboard that matters. */
function NorthStarBar({ data }: { data: NorthStar }): React.JSX.Element {
  const ns = EVERYDAY.northStar;
  const note = data.trend === "zero" ? ns.zero : data.trend === "up" ? ns.deltaUp : ns.deltaFlat;
  return (
    <section className="everyday-northstar" aria-label={ns.eyebrow}>
      <p className="everyday-eyebrow">{ns.eyebrow}</p>
      <div className="everyday-northstar__metrics">
        <div className="everyday-metric">
          <span className="everyday-metric__value">{compactCount(data.customers)}</span>
          <span className="everyday-metric__label">{ns.customersLabel}</span>
          <span className="everyday-metric__delta">{signedDelta(data.customersDelta)}</span>
        </div>
        <div className="everyday-metric">
          <span className="everyday-metric__value">{data.revenue}</span>
          <span className="everyday-metric__label">{ns.revenueLabel}</span>
          <span className="everyday-metric__delta">{data.revenueDelta}</span>
        </div>
      </div>
      <p className="everyday-northstar__note">{note}</p>
    </section>
  );
}

/** An inline deliverable: a draft body, or a before/after diff. Lands right in the thread and on cards. */
function DeliverableBody({ deliverable }: { deliverable: Deliverable }): React.JSX.Element {
  if (deliverable.kind === "diff") {
    return (
      <div className="everyday-deliverable everyday-deliverable--diff">
        <p className="everyday-deliverable__label">{EVERYDAY.thread.diffLabel}</p>
        {deliverable.before !== undefined && (
          <p className="everyday-diff everyday-diff--before">{deliverable.before}</p>
        )}
        <p className="everyday-diff everyday-diff--after">{deliverable.preview}</p>
      </div>
    );
  }
  return (
    <div className="everyday-deliverable everyday-deliverable--draft">
      <p className="everyday-deliverable__label">{EVERYDAY.thread.previewLabel}</p>
      <p className="everyday-deliverable__body">{deliverable.preview}</p>
    </div>
  );
}

/** The calm thread. Agent narration + inline deliverables, generous whitespace, no spinners-for-show. */
function Thread({ entries }: { entries: readonly ThreadEntry[] }): React.JSX.Element {
  const t = EVERYDAY.thread;
  return (
    <section className="everyday-thread" aria-label={t.heading}>
      <h2 className="everyday-serif everyday-thread__heading">{t.heading}</h2>
      {entries.length === 0 ? (
        <div className="everyday-empty">
          <p className="everyday-empty__line">{t.empty}</p>
          <p className="everyday-empty__nudge">{t.nudge}</p>
        </div>
      ) : (
        <ol className="everyday-thread__list">
          {entries.map((e) => (
            <li key={e.id} className="everyday-msg">
              <AgentChip name={e.agent} />
              <div className="everyday-msg__body">
                <p className="everyday-msg__meta">
                  <span className="everyday-msg__agent">{e.agent}</span>
                  <span className="everyday-msg__at">{e.at}</span>
                </p>
                {e.kind === "agent-line" ? (
                  <p className="everyday-msg__text">{e.text}</p>
                ) : (
                  <DeliverableBody deliverable={e.deliverable} />
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** One ship-decision card: the finished deliverable + the single consequence; money is the only hard gate. */
function ApprovalCardView({
  card,
  onShip,
}: {
  card: ApprovalCard;
  onShip: (id: string) => void;
}): React.JSX.Element {
  const a = EVERYDAY.approvals;
  const s = EVERYDAY.safety;
  const [confirmingSpend, setConfirmingSpend] = useState(false);

  function ship(): void {
    // Money is the one hard gate: a spend needs a second, explicit confirmation (#784).
    if (card.costsMoney && !confirmingSpend) {
      setConfirmingSpend(true);
      return;
    }
    onShip(card.id);
  }

  return (
    <article className="everyday-card">
      <header className="everyday-card__head">
        <AgentChip name={card.agent} />
        <div>
          <p className="everyday-eyebrow">{a.deliverableEyebrow}</p>
          <h3 className="everyday-card__title">{card.deliverable.title}</h3>
        </div>
      </header>
      <DeliverableBody deliverable={card.deliverable} />
      <p className="everyday-card__consequence">
        {a.consequencePrefix} {card.consequence}.
      </p>
      {card.costsMoney && (
        <p className="everyday-card__money" data-testid="money-gate">
          {s.moneyGate}
          {card.amount ? ` (${card.amount})` : ""}
        </p>
      )}
      <div className="everyday-card__actions">
        {confirmingSpend ? (
          <>
            <button type="button" className="everyday-btn everyday-btn--pop" onClick={ship}>
              {s.moneyGateApprove}
            </button>
            <button
              type="button"
              className="everyday-btn everyday-btn--ghost"
              onClick={() => setConfirmingSpend(false)}
            >
              {s.moneyGateHold}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="everyday-btn everyday-btn--pop" onClick={ship}>
              {a.ship}
            </button>
            <button
              type="button"
              className="everyday-btn everyday-btn--ghost"
              onClick={() => onShip(card.id)}
            >
              {a.redo}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

/** The approval queue — one-glance ship decisions, or a calm empty state. */
function ApprovalQueue({
  cards,
  onShip,
  justShipped,
}: {
  cards: readonly ApprovalCard[];
  onShip: (id: string) => void;
  justShipped: boolean;
}): React.JSX.Element {
  const a = EVERYDAY.approvals;
  return (
    <section className="everyday-approvals" aria-label={a.heading}>
      <h2 className="everyday-serif everyday-approvals__heading">{a.heading}</h2>
      <p className="everyday-approvals__subhead">{a.subhead}</p>
      {justShipped && (
        <p className="everyday-celebrate" role="status">
          {EVERYDAY.celebrate.shipped}
        </p>
      )}
      {cards.length === 0 ? (
        <p className="everyday-empty__line">{a.empty}</p>
      ) : (
        <div className="everyday-approvals__list">
          {cards.map((c) => (
            <ApprovalCardView key={c.id} card={c} onShip={onShip} />
          ))}
        </div>
      )}
    </section>
  );
}

/** The quiet transparency log — every external action, timestamped + linked. Reassurance, not noise. */
function TransparencyLog({ actions }: { actions: readonly ExternalAction[] }): React.JSX.Element {
  const x = EVERYDAY.transparency;
  const [query, setQuery] = useState("");
  const [undone, setUndone] = useState<readonly string[]>([]);
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? actions.filter((act) =>
        `${act.at} ${act.action} ${act.href} ${act.receiptLabel ?? ""}`
          .toLowerCase()
          .includes(needle),
      )
    : actions;
  return (
    <section className="everyday-log" aria-label={x.heading}>
      <h2 className="everyday-serif everyday-log__heading">{x.heading}</h2>
      <p className="everyday-log__subhead">{x.subhead}</p>
      <label className="everyday-log__search">
        <span className="sr-only">{x.searchLabel}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={x.searchPlaceholder}
        />
      </label>
      {actions.length === 0 ? (
        <p className="everyday-empty__line">{x.empty}</p>
      ) : visible.length === 0 ? (
        <p className="everyday-empty__line">{x.noResults}</p>
      ) : (
        <ul className="everyday-log__list">
          {visible.map((act) => (
            <li key={act.id} className="everyday-log__row">
              <span className="everyday-log__when" aria-label={x.whenLabel}>
                {act.at}
              </span>
              <span className="everyday-log__action">{act.action}</span>
              <a
                className="everyday-log__link"
                href={act.href}
                target="_blank"
                rel="noreferrer noopener"
              >
                {act.receiptLabel ?? x.viewLink}
              </a>
              {act.undoLabel && !undone.includes(act.id) && (
                <button
                  type="button"
                  className="everyday-log__undo"
                  onClick={() => setUndone((ids) => [...ids, act.id])}
                >
                  {act.undoLabel}
                </button>
              )}
              {undone.includes(act.id) && <span className="everyday-log__undone">{x.undone}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Money + kill-switch, framed as reassurance. The kill switch is ALWAYS on — there is nothing to configure. */
function SafetyFooter({ paused }: { paused: boolean }): React.JSX.Element {
  const s = EVERYDAY.safety;
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="everyday-safety" aria-label={s.killSwitchTitle}>
      <p className="everyday-eyebrow">{s.eyebrow}</p>
      <h2 className="everyday-serif everyday-safety__title">{s.killSwitchTitle}</h2>
      <p className="everyday-safety__body">{s.killSwitchBody}</p>
      <div className="everyday-safety__action">
        {confirming ? (
          <button
            type="button"
            className="everyday-btn everyday-btn--stop"
            onClick={() => setConfirming(false)}
          >
            {s.killSwitchAction}
          </button>
        ) : (
          <button
            type="button"
            className="everyday-btn everyday-btn--ghost"
            aria-pressed={paused}
            onClick={() => setConfirming(true)}
          >
            {s.killSwitchAction}
          </button>
        )}
      </div>
    </section>
  );
}

/** The composer — the one ever-present input that starts everything, under the greeting. */
function Composer(): React.JSX.Element {
  return (
    <form
      className="everyday-composer"
      onSubmit={(ev) => ev.preventDefault()}
      aria-label={EVERYDAY.prompt}
    >
      <input
        className="everyday-composer__input"
        type="text"
        placeholder={EVERYDAY.composerPlaceholder}
        aria-label={EVERYDAY.prompt}
      />
      <button type="submit" className="everyday-btn everyday-btn--pop">
        {EVERYDAY.composerSend}
      </button>
    </form>
  );
}

/**
 * The everyday shell. Presentational + self-contained: takes the full {@link EverydayData} (defaulting to a
 * realistic seed for the flagged preview) and an injectable `hour` so the greeting bucket is deterministic
 * in tests. Shipping a card is local UI state here (a small celebration); wiring real approve/redo to the
 * live approvals API is the documented follow-up.
 */
export function EverydayShell({
  data = seedEveryday(),
  hour = 14,
}: {
  data?: EverydayData;
  hour?: number;
}): React.JSX.Element {
  const [shipped, setShipped] = useState<readonly string[]>([]);
  const pending = data.approvals.filter((c) => !shipped.includes(c.id));
  const greeting = EVERYDAY.greeting(data.memberName, partOfDay(hour));

  return (
    <div className="everyday-shell">
      <main className="everyday-shell__main">
        <header className="everyday-door">
          <h1 className="everyday-serif everyday-door__greeting">{greeting}</h1>
          <Composer />
        </header>

        <NorthStarBar data={data.northStar} />
        <Thread entries={data.thread} />
        <ApprovalQueue
          cards={pending}
          justShipped={shipped.length > 0}
          onShip={(id) => setShipped((s) => [...s, id])}
        />
        <TransparencyLog actions={data.transparency} />
        <SafetyFooter paused={data.fleetPaused} />
      </main>
    </div>
  );
}
