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
import { api } from "../../api/client.js";
import { EVERYDAY } from "../../brand.js";
import { experienceTokenStyle } from "../../design/ipop-experience-tokens.js";
import {
  type ApprovalCard,
  type Deliverable,
  type EverydayData,
  type EverydayConnector,
  type ExternalAction,
  type AgentLane,
  type NorthStar,
  type ThreadEntry,
  compactCount,
  defaultAgentRoom,
  emptyEverydayData,
  partOfDay,
  signedDelta,
} from "./everyday-data.js";

export type EverydayDecisionStatus = "idle" | "pending" | "shipped" | "revision" | "error";

export interface EverydayApprovalActions {
  ship(card: ApprovalCard): Promise<void>;
  requestRevision(card: ApprovalCard, note: string): Promise<void>;
}

export const defaultEverydayApprovalActions: EverydayApprovalActions = {
  async ship(card) {
    await api.approvals.approve(card.approvalRequestId, "Ship from everyday shell");
  },
  async requestRevision(card, note) {
    await api.approvals.reject(card.approvalRequestId, note);
  },
};

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

function chatPreviewFrom({
  entries,
  lanes,
  memberName,
}: {
  entries: readonly ThreadEntry[];
  lanes: readonly AgentLane[];
  memberName: string;
}): readonly ThreadEntry[] {
  if (entries.length > 0) return entries.slice(-5);
  const working = lanes.find((lane) => lane.status === "working") ?? lanes[0];
  return [
    {
      id: "welcome-user",
      kind: "agent-line",
      agent: memberName,
      at: EVERYDAY.room.chatLabel,
      text: "build ipop like Tomo, but for serious marketing work",
    },
    {
      id: "welcome-scout",
      kind: "agent-line",
      agent: working?.agent ?? "Scout",
      at: "now",
      text: working?.task ?? "Mining category, product, user, time, space, and experience tensions before we write.",
    },
    {
      id: "welcome-codex",
      kind: "agent-line",
      agent: "Operator",
      at: "ready",
      text: "Team engine active. I can turn the team's approved marketing/product decisions into implementation work.",
    },
  ];
}

function GroupChatHero({
  greeting,
  lanes,
  thread,
  memberName,
  onSubmit,
}: {
  greeting: string;
  lanes: readonly AgentLane[];
  thread: readonly ThreadEntry[];
  memberName: string;
  onSubmit: (goal: string) => void;
}): React.JSX.Element {
  const preview = chatPreviewFrom({ entries: thread, lanes, memberName });
  return (
    <header className="everyday-hero">
      <div className="everyday-hero__brief">
        <p className="everyday-eyebrow">{EVERYDAY.room.chatLabel}</p>
        <h1 className="everyday-serif everyday-door__greeting">{greeting}</h1>
        <Composer onSubmit={onSubmit} />
      </div>
      <section className="everyday-chat everyday-imessage" aria-label={EVERYDAY.room.heading}>
        <div className="everyday-chat__topbar">
          <div>
            <h2 className="everyday-serif everyday-chat__title">{EVERYDAY.room.heading}</h2>
            <p className="everyday-chat__subhead">{EVERYDAY.room.subhead}</p>
            <p className="everyday-imessage__note">{EVERYDAY.room.imessageNote}</p>
          </div>
          <div className="everyday-chat__avatars" aria-label="agents in the room">
            {lanes.slice(0, 5).map((lane) => (
              <span key={lane.id} className="everyday-chat__avatar" data-status={lane.status} title={lane.agent}>
                {lane.agent.trim()[0]?.toUpperCase() ?? "?"}
              </span>
            ))}
          </div>
        </div>
        <p className="everyday-imessage__badge">{EVERYDAY.room.codexBadge}</p>
        <ol className="everyday-chat__messages">
          {preview.map((entry) => (
            <li
              key={entry.id}
              className="everyday-chat__message"
              data-author={entry.agent === memberName ? "user" : "agent"}
            >
              <AgentChip name={entry.agent} />
              <div className="everyday-chat__bubble">
                <p className="everyday-msg__meta">
                  <span className="everyday-msg__agent">{entry.agent}</span>
                  <span className="everyday-msg__at">{entry.at}</span>
                </p>
                {entry.kind === "agent-line" ? (
                  <p className="everyday-msg__text">{entry.text}</p>
                ) : (
                  <DeliverableBody deliverable={entry.deliverable} />
                )}
              </div>
            </li>
          ))}
        </ol>
        <div className="everyday-chat__lanes">
          {lanes.slice(0, 5).map((lane) => (
            <article key={lane.id} className="everyday-chat__lane" data-status={lane.status}>
              <span>{lane.agent}</span>
              <strong>{EVERYDAY.room.statuses[lane.status]}</strong>
            </article>
          ))}
        </div>
      </section>
    </header>
  );
}

function ConnectorSetup({
  connectors,
  onConnect,
}: {
  connectors: readonly EverydayConnector[];
  onConnect: (id: string) => void;
}): React.JSX.Element {
  const c = EVERYDAY.connectors;
  const groups = (["visibility", "productivity", "marketing", "publishing"] as const)
    .map((group) => ({
      group,
      items:
        group === "visibility"
          ? connectors.filter((item) => item.id === "imessage")
          : connectors.filter((item) => item.group === group),
    }))
    .filter(({ items }) => items.length > 0);

  return (
    <section className="everyday-connectors" aria-label={c.heading}>
      <div className="everyday-connectors__intro">
        <h2 className="everyday-serif everyday-connectors__heading">{c.heading}</h2>
        <p className="everyday-connectors__subhead">{c.subhead}</p>
      </div>
      <div className="everyday-connectors__groups">
        {groups.map(({ group, items }) => (
          <section key={group} className="everyday-connector-group" aria-label={c.groups[group]}>
            <h3 className="everyday-connector-group__heading">{c.groups[group]}</h3>
            <ul className="everyday-connector-list">
              {items.map((item) => (
                <li key={item.id} className="everyday-connector" data-status={item.status}>
                  <div>
                    <p className="everyday-connector__name">{item.name}</p>
                    <p className="everyday-connector__detail">{item.detail}</p>
                  </div>
                  {item.status === "connected" ? (
                    <span className="everyday-connector__badge">{c.connected}</span>
                  ) : (
                    <button type="button" className="everyday-connector__link" onClick={() => onConnect(item.id)}>
                      {item.actionLabel}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}

/** One ship-decision card: the finished deliverable + the single consequence; money is the only hard gate. */
function ApprovalCardView({
  card,
  onShip,
  onRedo,
  status,
  error,
}: {
  card: ApprovalCard;
  onShip: (card: ApprovalCard) => Promise<void>;
  onRedo: (card: ApprovalCard, note: string) => Promise<void>;
  status: EverydayDecisionStatus;
  error?: string;
}): React.JSX.Element {
  const a = EVERYDAY.approvals;
  const s = EVERYDAY.safety;
  const [confirmingSpend, setConfirmingSpend] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const [note, setNote] = useState("");

  function ship(): void {
    // Money is the one hard gate: a spend needs a second, explicit confirmation (#784).
    if (card.costsMoney && !confirmingSpend) {
      setConfirmingSpend(true);
      return;
    }
    void onShip(card);
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
      {status === "pending" && (
        <p className="everyday-card__state" role="status">
          {a.pending}
        </p>
      )}
      {status === "error" && error && (
        <p className="everyday-card__state everyday-card__state--error" role="alert">
          {error}
        </p>
      )}
      {redoing && (
        <label className="everyday-card__redo">
          {a.redoNote}
          <textarea
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            placeholder={a.redoPlaceholder}
          />
        </label>
      )}
      <div className="everyday-card__actions">
        {confirmingSpend ? (
          <>
            <button type="button" className="everyday-btn everyday-btn--pop" onClick={ship} disabled={status === "pending"}>
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
            <button type="button" className="everyday-btn everyday-btn--pop" onClick={ship} disabled={status === "pending"}>
              {a.ship}
            </button>
            <button
              type="button"
              className="everyday-btn everyday-btn--ghost"
              disabled={status === "pending"}
              onClick={() => {
                if (!redoing) {
                  setRedoing(true);
                  return;
                }
                void onRedo(card, note.trim() || a.redoDefaultNote);
              }}
            >
              {redoing ? a.redoSend : a.redo}
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
  onRedo,
  justShipped,
  statuses,
  errors,
}: {
  cards: readonly ApprovalCard[];
  onShip: (card: ApprovalCard) => Promise<void>;
  onRedo: (card: ApprovalCard, note: string) => Promise<void>;
  justShipped: boolean;
  statuses: Readonly<Record<string, EverydayDecisionStatus>>;
  errors: Readonly<Record<string, string>>;
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
            <ApprovalCardView
              key={c.id}
              card={c}
              onShip={onShip}
              onRedo={onRedo}
              status={statuses[c.id] ?? "idle"}
              error={errors[c.id]}
            />
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
function Composer({ onSubmit }: { onSubmit: (value: string) => void }): React.JSX.Element {
  const [value, setValue] = useState("");
  return (
    <form
      className="everyday-composer"
      onSubmit={(ev) => {
        ev.preventDefault();
        const next = value.trim();
        if (!next) return;
        onSubmit(next);
        setValue("");
      }}
      aria-label={EVERYDAY.prompt}
    >
      <input
        className="everyday-composer__input"
        type="text"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
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
 * The everyday shell. Presentational + self-contained: takes the full {@link EverydayData}. The fallback is
 * an honest empty live state, not the demo seed; explicit demos/tests can still pass seedEveryday().
 * Ship/redo decisions go through the approval-action seam; a card only leaves the queue once the backend
 * records the decision.
 */
export function EverydayShell({
  data = emptyEverydayData(),
  hour = 14,
  approvalActions = defaultEverydayApprovalActions,
  onConnectorConnect = () => undefined,
  onStartRoom,
}: {
  data?: EverydayData;
  hour?: number;
  approvalActions?: EverydayApprovalActions;
  onConnectorConnect?: (id: string) => void;
  onStartRoom?: (goal: string) => Promise<void> | void;
}): React.JSX.Element {
  const [shipped, setShipped] = useState<readonly string[]>([]);
  const [statuses, setStatuses] = useState<Record<string, EverydayDecisionStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [room, setRoom] = useState<readonly AgentLane[]>(data.room);
  const [localThread, setLocalThread] = useState<readonly ThreadEntry[]>([]);
  const pending = data.approvals.filter((c) => !shipped.includes(c.id));
  const greeting = EVERYDAY.greeting(data.memberName, partOfDay(hour));
  const thread = [...data.thread, ...localThread];

  function startRoom(goal: string): void {
    setRoom(defaultAgentRoom(goal));
    setLocalThread((entries) => [
      ...entries,
      {
        id: "local-" + Date.now(),
        kind: "agent-line",
        agent: data.memberName,
        at: EVERYDAY.room.chatLabel,
        text: goal,
      },
      {
        id: "room-" + Date.now(),
        kind: "agent-line",
        agent: "Scout",
        at: "just now",
        text: EVERYDAY.thread.working("Scout"),
      },
      {
        id: "codex-" + Date.now(),
        kind: "agent-line",
        agent: "Operator",
        at: "ready",
        text: "I can take product/code handoffs once the team agrees what should ship.",
      },
    ]);
    Promise.resolve(onStartRoom?.(goal)).catch((err) => {
      setLocalThread((entries) => [
        ...entries,
        {
          id: "codex-error-" + Date.now(),
          kind: "agent-line",
          agent: "Operator",
          at: "blocked",
          text: err instanceof Error ? err.message : "I could not start the team room run.",
        },
      ]);
    });
  }

  async function decide(card: ApprovalCard, kind: "ship" | "redo", note?: string): Promise<void> {
    setStatuses((prev) => ({ ...prev, [card.id]: "pending" }));
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== card.id)));
    try {
      if (kind === "ship") await approvalActions.ship(card);
      else await approvalActions.requestRevision(card, note ?? EVERYDAY.approvals.redoDefaultNote);
      setStatuses((prev) => ({ ...prev, [card.id]: kind === "ship" ? "shipped" : "revision" }));
      setShipped((ids) => (ids.includes(card.id) ? ids : [...ids, card.id]));
    } catch (err) {
      setStatuses((prev) => ({ ...prev, [card.id]: "error" }));
      setErrors((prev) => ({
        ...prev,
        [card.id]: err instanceof Error ? err.message : EVERYDAY.approvals.decisionError,
      }));
    }
  }

  return (
    <div className="everyday-shell" style={experienceTokenStyle("everyday")}>
      <main className="everyday-shell__main">
        <GroupChatHero
          greeting={greeting}
          lanes={room}
          thread={thread}
          memberName={data.memberName}
          onSubmit={startRoom}
        />
        <ConnectorSetup connectors={data.connectors} onConnect={onConnectorConnect} />
        <NorthStarBar data={data.northStar} />
        <ApprovalQueue
          cards={pending}
          justShipped={shipped.length > 0}
          onShip={(card) => decide(card, "ship")}
          onRedo={(card, note) => decide(card, "redo", note)}
          statuses={statuses}
          errors={errors}
        />
        <TransparencyLog actions={data.transparency} />
        <SafetyFooter paused={data.fleetPaused} />
      </main>
    </div>
  );
}
