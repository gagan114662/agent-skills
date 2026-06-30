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
import { useEffect, useState } from "react";
import { api } from "../../api/client.js";
import type { IMessageStatusResponse } from "../../api/types.js";
import { EVERYDAY } from "../../brand.js";
import { CopyButton } from "../CopyButton.js";
import { experienceTokenStyle } from "../../design/ipop-experience-tokens.js";
import { APP_ROUTES } from "../../routing.js";
import {
  type ApprovalCard,
  type Deliverable,
  type EverydayData,
  type EverydayConnector,
  type ExternalAction,
  type AgentLane,
  type MarketingAction,
  type MarketingBrief,
  type NorthStar,
  type ThreadEntry,
  compactCount,
  defaultAgentRoom,
  emptyEverydayData,
  partOfDay,
  signedDelta,
} from "./everyday-data.js";

export type EverydayDecisionStatus = "idle" | "pending" | "shipped" | "revision" | "error";

export interface EverydayRoomLaunchResult {
  notices?: readonly string[];
}

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

const INTERNAL_TOOL_COMMAND_RE =
  /^(?:(?:\/usr\/bin\/|\/bin\/)?(?:sh|bash|zsh)\s+-lc\b|(?:sed|cat|awk|grep|rg|find|curl|gh|git|pnpm|npm|yarn|node|tsx|python3?|flyctl|vercel)\b)/i;

function firstCustomerVisibleLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith(String.fromCharCode(96).repeat(3)))[0] ?? ""
  );
}

function looksLikeInternalToolActivity(text: string): boolean {
  const firstLine = firstCustomerVisibleLine(text).replace(/^\$\s*/, "");
  return INTERNAL_TOOL_COMMAND_RE.test(firstLine);
}

function customerVisibleAgentText(text: string): string {
  return looksLikeInternalToolActivity(text) ? EVERYDAY.thread.internalToolActivity : text;
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
          <p className="everyday-diff everyday-diff--before">{customerVisibleAgentText(deliverable.before)}</p>
        )}
        <p className="everyday-diff everyday-diff--after">{customerVisibleAgentText(deliverable.preview)}</p>
      </div>
    );
  }
  return (
    <div className="everyday-deliverable everyday-deliverable--draft">
      <p className="everyday-deliverable__label">{EVERYDAY.thread.previewLabel}</p>
      <p className="everyday-deliverable__body">{customerVisibleAgentText(deliverable.preview)}</p>
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
  operatorPacket,
  imessageStatus,
}: {
  greeting: string;
  lanes: readonly AgentLane[];
  thread: readonly ThreadEntry[];
  memberName: string;
  onSubmit: (goal: string) => void;
  operatorPacket?: string | null;
  imessageStatus?: IMessageStatusResponse | null;
}): React.JSX.Element {
  const preview = chatPreviewFrom({ entries: thread, lanes, memberName });
  const packetCopy = EVERYDAY.codexLane;
  const imessageNote = roomIMessageNote(imessageStatus);
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
            <p className="everyday-imessage__note">{imessageNote}</p>
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
                  <p className="everyday-msg__text">
                    {entry.agent === memberName ? entry.text : customerVisibleAgentText(entry.text)}
                  </p>
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
        {operatorPacket && (
          <section className="everyday-operator-packet" aria-label={packetCopy.packetTitle}>
            <div>
              <p className="everyday-eyebrow">{packetCopy.title}</p>
              <h3>{packetCopy.packetTitle}</h3>
              <p>{packetCopy.packetBody}</p>
            </div>
            <div className="everyday-operator-packet__actions">
              <CopyButton text={operatorPacket} label={packetCopy.copyPacket} />
              <details>
                <summary>{packetCopy.openPacket}</summary>
                <pre>{operatorPacket}</pre>
              </details>
            </div>
          </section>
        )}
      </section>
    </header>
  );
}

function roomIMessageNote(status?: IMessageStatusResponse | null): string {
  const copy = EVERYDAY.room.imessageNotes;
  if (status?.relay?.roomReady || status?.lastInboundReceipt) return copy.ready;
  if (status?.relay?.roomStartReady) return copy.replyNeeded;
  if (status?.memberRecipient?.verified || status?.relayHeartbeat) return copy.relayBlocked;
  return copy.setupNeeded;
}

function ConnectorSetup({
  connectors,
  onConnect,
  imessageStatus,
  onSaveIMessageRecipient,
  onTestIMessageRecipient,
  onDeleteIMessageRecipient,
}: {
  connectors: readonly EverydayConnector[];
  onConnect?: (id: string) => void;
  imessageStatus?: IMessageStatusResponse | null;
  onSaveIMessageRecipient?: (input: { recipient: string; serviceName?: string }) => Promise<void> | void;
  onTestIMessageRecipient?: () => Promise<void> | void;
  onDeleteIMessageRecipient?: () => Promise<void> | void;
}): React.JSX.Element {
  const c = EVERYDAY.connectors;
  const groups = (["visibility", "productivity", "marketing", "publishing"] as const)
    .map((group) => ({
      group,
      items:
        group === "visibility"
          ? connectors.filter((item) => item.group === "visibility")
          : connectors.filter((item) => item.group === group),
    }))
    .filter(({ items }) => items.length > 0);

  return (
    <section className="everyday-connectors" aria-label={c.heading}>
      <div className="everyday-connectors__intro">
        <h2 className="everyday-serif everyday-connectors__heading">{c.heading}</h2>
        <p className="everyday-connectors__subhead">{c.subhead}</p>
      </div>
      {(onSaveIMessageRecipient || imessageStatus) && (
        <IMessageSetup
          status={imessageStatus}
          onSave={onSaveIMessageRecipient}
          onTest={onTestIMessageRecipient}
          onDelete={onDeleteIMessageRecipient}
        />
      )}
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
                  ) : onConnect ? (
                    <button type="button" className="everyday-connector__link" onClick={() => onConnect(item.id)}>
                      {item.actionLabel}
                    </button>
                  ) : (
                    <div className="everyday-connector__public">
                      <a className="everyday-connector__link" href={APP_ROUTES.everyday}>
                        {c.publicAction}
                      </a>
                      <span>{c.publicHint}</span>
                    </div>
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

function IMessageSetup({
  status,
  onSave,
  onTest,
  onDelete,
}: {
  status?: IMessageStatusResponse | null;
  onSave?: (input: { recipient: string; serviceName?: string }) => Promise<void> | void;
  onTest?: () => Promise<void> | void;
  onDelete?: () => Promise<void> | void;
}): React.JSX.Element {
  const copy = EVERYDAY.connectors.imessage;
  const recipient = status?.memberRecipient?.recipient ?? "";
  const serviceName = status?.memberRecipient?.serviceName ?? "";
  const [recipientInput, setRecipientInput] = useState(recipient);
  const [serviceInput, setServiceInput] = useState(serviceName);
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const verified = Boolean(status?.memberRecipient?.verified);
  const relayJob = status?.lastRelayJob ?? null;
  const relayHeartbeat = status?.relayHeartbeat ?? null;
  const relayReadiness = status?.relay ?? null;
  const jobSummary = relayReadiness?.jobSummary ?? null;
  const messagesAccess = relayHeartbeat?.messagesAccess ?? "unknown";
  const messagesDbAccess = relayHeartbeat?.messagesDbAccess ?? "unknown";
  const legacyRelayCanSend = Boolean(
    verified &&
      status?.enabled &&
      status.configured &&
      !status.dryRun &&
      relayHeartbeat?.active &&
      messagesAccess === "ok" &&
      messagesDbAccess === "ok",
  );
  const roomStartReady = Boolean(verified && (relayReadiness?.roomStartReady ?? legacyRelayCanSend));
  const loopbackReady = Boolean(verified && (relayReadiness?.loopbackReady ?? status?.lastInboundReceipt));
  const relayBlocked = Boolean(verified && !roomStartReady);
  const pending = Boolean(status?.memberRecipient && !verified);
  const stateLabel = loopbackReady
    ? copy.verified
    : roomStartReady
      ? copy.loopPending
      : relayBlocked
        ? copy.blocked
        : pending
          ? copy.pending
          : copy.notSet;
  const detail = loopbackReady
    ? copy.readyDetail
    : roomStartReady
      ? copy.loopPendingDetail
      : relayBlocked
        ? copy.blockedDetail
        : pending
          ? copy.pendingDetail
          : copy.emptyDetail;
  const inboundReceipt = status?.lastInboundReceipt ?? null;
  const relayHostProof = relayHeartbeat
    ? relayHeartbeat.active
      ? messagesAccess === "ok"
        ? messagesDbAccess === "ok"
          ? "Mac relay host active with Messages send and reply access: " + relayHeartbeat.host
          : messagesDbAccess === "failed"
            ? "Mac relay host active, but Messages reply-sync access is blocked: " + relayHeartbeat.host
            : "Mac relay host active; Messages reply-sync access not proven: " + relayHeartbeat.host
        : messagesAccess === "failed"
          ? "Mac relay host active, but Messages send access is blocked: " + relayHeartbeat.host
          : "Mac relay API heartbeat active; Messages send access not proven: " + relayHeartbeat.host
      : "Mac relay host stale: last check-in " + relayHeartbeat.checkedInAt
    : "Mac relay host has not checked in yet.";
  const relayProof = relayJobProof(relayJob);
  const inboundProof = inboundReceipt
    ? "last inbound iMessage reply landed: " + inboundReceipt.receipt
    : null;
  const relayFacts = relayReadiness
    ? [
        { label: "queue", value: relayReadiness.queueReady ? "ready" : "missing secret", state: relayReadiness.queueReady ? "ok" : "warn" },
        { label: "Mac host", value: relayReadiness.heartbeatReady ? "healthy" : relayHeartbeat?.active ? "needs access" : "waiting", state: relayReadiness.heartbeatReady ? "ok" : "warn" },
        { label: "reply loop", value: relayReadiness.loopbackReady ? "proven" : "waiting", state: relayReadiness.loopbackReady ? "ok" : "warn" },
        { label: "pending", value: String(jobSummary?.pending ?? 0), state: jobSummary?.pending ? "warn" : "ok" },
        { label: "sent", value: jobSummary?.lastSentAt ? shortDateTime(jobSummary.lastSentAt) : String(jobSummary?.sent ?? 0), state: jobSummary?.sent ? "ok" : "idle" },
      ]
    : [];

  useEffect(() => {
    setRecipientInput(recipient);
    setServiceInput(serviceName);
  }, [recipient, serviceName]);

  async function run(kind: "save" | "test" | "delete", action?: () => Promise<void> | void): Promise<void> {
    if (!action) return;
    setBusy(kind);
    setNotice(null);
    setError(null);
    try {
      await action();
      setNotice(kind === "save" ? copy.saved : kind === "test" ? copy.tested : copy.removed);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : copy.error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className="everyday-imessage-setup"
      aria-label={copy.title}
      data-state={loopbackReady ? "verified" : pending || relayBlocked || roomStartReady ? "pending" : "empty"}
    >
      <div className="everyday-imessage-setup__copy">
        <div>
          <h3>{copy.title}</h3>
          <p>{copy.body}</p>
        </div>
        <span>{stateLabel}</span>
      </div>
      <form
        className="everyday-imessage-setup__form"
        onSubmit={(event) => {
          event.preventDefault();
          const nextRecipient = recipientInput.trim();
          if (!nextRecipient) return;
          void run("save", () => onSave?.({ recipient: nextRecipient, serviceName: serviceInput.trim() || undefined }));
        }}
      >
        <label>
          <span>{copy.label}</span>
          <input
            value={recipientInput}
            onChange={(event) => setRecipientInput(event.currentTarget.value)}
            placeholder={copy.placeholder}
          />
        </label>
        <label>
          <span>{copy.serviceLabel}</span>
          <input
            value={serviceInput}
            onChange={(event) => setServiceInput(event.currentTarget.value)}
            placeholder={copy.servicePlaceholder}
          />
        </label>
        <div className="everyday-imessage-setup__actions">
          <button type="submit" className="everyday-btn everyday-btn--ghost" disabled={busy !== null}>
            {copy.save}
          </button>
          <button
            type="button"
            className="everyday-btn everyday-btn--pop"
            disabled={busy !== null || !status?.memberRecipient}
            onClick={() => void run("test", onTest)}
          >
            {copy.test}
          </button>
          {status?.memberRecipient && (
            <button
              type="button"
              className="everyday-btn everyday-btn--ghost"
              disabled={busy !== null}
              onClick={() => void run("delete", onDelete)}
            >
              {copy.disconnect}
            </button>
          )}
        </div>
      </form>
      <p className="everyday-imessage-setup__detail">{detail}</p>
      {relayFacts.length > 0 && (
        <dl className="everyday-imessage-setup__relay" aria-label="iMessage relay readiness">
          {relayFacts.map((fact) => (
            <div key={fact.label} data-state={fact.state}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="everyday-imessage-setup__detail">{relayHostProof}</p>
      {relayProof && <p className="everyday-imessage-setup__detail">{relayProof}</p>}
      {jobSummary?.lastError && <p className="everyday-imessage-setup__error">last relay failure: {jobSummary.lastError}</p>}
      {inboundProof && <p className="everyday-imessage-setup__detail">{inboundProof}</p>}
      {notice && <p className="everyday-imessage-setup__notice" role="status">{notice}</p>}
      {error && <p className="everyday-imessage-setup__error" role="alert">{error}</p>}
    </section>
  );
}

function shortDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function relayJobProof(job: IMessageStatusResponse["lastRelayJob"] | null | undefined): string | null {
  if (!job) return null;
  if (job.status === "sent") return "last iMessage relay sent: " + (job.receipt ?? job.purpose);
  if (job.status === "failed") return "last iMessage relay failed: " + (job.error ?? "relay send failed");
  if (job.status === "claimed") return "last iMessage relay claimed by " + (job.lockedBy ?? "Mac relay");
  if (job.status === "pending") return "last iMessage relay queued: " + job.purpose;
  return null;
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

function WorkSummary({ data }: { data: EverydayData }): React.JSX.Element {
  const d = EVERYDAY.dashboard;
  const brief = data.marketingBrief ?? fallbackMarketingBrief(data);
  const latest = data.transparency.slice(-3).reverse();
  return (
    <section id="dashboard" className="everyday-dashboard" aria-label={d.heading}>
      <div className="everyday-dashboard__head">
        <div>
          <p className="everyday-dashboard__mode">{brief.mode === "sample" ? d.sample : d.live}</p>
          <h2 className="everyday-serif everyday-dashboard__heading">{d.heading}</h2>
          <p className="everyday-dashboard__subhead">{d.subhead}</p>
          <p className="everyday-dashboard__headline">{brief.headline}</p>
          <div className="everyday-dashboard__executive" aria-label={d.executive}>
            <p className="everyday-eyebrow">{d.executive}</p>
            <ol>
              {brief.executiveSummary.map((signal) => (
                <li key={signal.label} data-tone={signal.tone}>
                  <span>{signal.label}</span>
                  <strong>{signal.value}</strong>
                  <em>{signal.detail}</em>
                  <b>{signal.proof}</b>
                </li>
              ))}
            </ol>
          </div>
          <div className="everyday-dashboard__since" aria-label={d.since}>
            <p className="everyday-eyebrow">{d.since}</p>
            <ul>
              {brief.sinceLastCheckIn.slice(0, 3).map((change) => (
                <li key={change.title}>
                  <strong>{change.title}</strong>
                  <span>{change.owner}</span>
                  <em>{change.proof}</em>
                </li>
              ))}
            </ul>
          </div>
          <div className="everyday-dashboard__goal" data-confidence={brief.goal.confidence}>
            <span>{brief.goal.label}</span>
            <strong>{brief.goal.current}</strong>
            <em>{d.goalTarget}: {brief.goal.target}</em>
            <em>{d.pace}: {brief.goal.pace}</em>
          </div>
        </div>
        <ol className="everyday-dashboard__metrics" aria-label={d.heading + " metrics"}>
          {brief.metrics.map((metric) => (
            <li key={metric.label} className="everyday-dashboard__metric">
              <small data-proof-kind={metric.proofKind} title={metric.proof}>
                {proofKindLabel(metric.proofKind)}
              </small>
              <strong>{metric.value}</strong>
              <span>{metric.label}</span>
              <em data-tone={metric.tone}>{metric.detail}</em>
              <b>{metric.proof}</b>
            </li>
          ))}
        </ol>
      </div>
      <div className="everyday-dashboard__ranked-work" aria-label={d.rankedWork}>
        <p className="everyday-eyebrow">{d.rankedWork}</p>
        <ol>
          {brief.rankedWork.map((item) => (
            <li key={item.agent + item.work} data-status={item.status}>
              <span>{item.agent}</span>
              <strong>{item.work}</strong>
              <em>{item.impact}</em>
              <b>{item.proof}</b>
            </li>
          ))}
        </ol>
      </div>
      <div className="everyday-dashboard__capacity" aria-label={d.capacity}>
        <p className="everyday-eyebrow">{d.capacity}</p>
        <ol>
          {brief.capacity.map((item) => (
            <li key={item.label} data-tone={item.tone}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <em>{item.detail}</em>
              <b>{item.proof}</b>
            </li>
          ))}
        </ol>
      </div>
      <div className="everyday-dashboard__readiness">
        <p className="everyday-eyebrow">launch readiness</p>
        <ol className="everyday-dashboard__readiness-list">
          {brief.readiness.map((item) => (
            <li key={item.label} data-status={item.status}>
              <span>{item.label}</span>
              <strong>{item.status}</strong>
              <em>{item.proof}</em>
            </li>
          ))}
        </ol>
      </div>
      <div className="everyday-dashboard__funnel">
        <p className="everyday-eyebrow">{d.funnel}</p>
        <ol className="everyday-dashboard__funnel-list">
          {brief.funnel.map((stage) => (
            <li key={stage.label} data-tone={stage.tone}>
              <strong>{stage.count}</strong>
              <span>{stage.label}</span>
              <em>{stage.detail}</em>
            </li>
          ))}
        </ol>
      </div>
      <div className="everyday-dashboard__channels">
        <p className="everyday-eyebrow">{d.channels}</p>
        <div className="everyday-dashboard__table" role="table" aria-label={d.channels}>
          <div className="everyday-dashboard__row everyday-dashboard__row--head" role="row">
            <span role="columnheader">{d.source}</span>
            <span role="columnheader">{d.status}</span>
            <span role="columnheader">{d.pipeline}</span>
            <span role="columnheader">{d.conversion}</span>
            <span role="columnheader">{d.spend}</span>
            <span role="columnheader">{d.move}</span>
          </div>
          {brief.channels.map((channel) => (
            <div key={channel.source} className="everyday-dashboard__row" role="row">
              <strong role="cell">{channel.source}</strong>
              <span role="cell">{channel.status}</span>
              <span role="cell">{channel.pipeline}</span>
              <span role="cell">{channel.conversion}</span>
              <span role="cell">{channel.spend}</span>
              <span role="cell">{channel.next}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="everyday-dashboard__brief-lists">
        <div>
          <p className="everyday-eyebrow">{d.blockers}</p>
          <BriefActionList actions={brief.blockers} empty={d.empty} />
        </div>
        <div>
          <p className="everyday-eyebrow">{d.decisions}</p>
          <BriefActionList actions={brief.decisions} empty={d.empty} />
        </div>
        <div>
          <p className="everyday-eyebrow">{d.next}</p>
          <BriefActionList actions={brief.nextActions} empty={d.empty} />
        </div>
      </div>
      <div className="everyday-dashboard__latest">
        <p className="everyday-eyebrow">{d.latest}</p>
        {latest.length === 0 ? (
          <p className="everyday-empty__line">{d.empty}</p>
        ) : (
          <ul className="everyday-dashboard__list">
            {latest.map((receipt) => (
              <li key={receipt.id}>
                <span>{receipt.at}</span>
                <strong>{receipt.action}</strong>
                <a href={receipt.href}>{receipt.receiptLabel ?? receipt.href}</a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function proofKindLabel(kind: MarketingBrief["metrics"][number]["proofKind"]): string {
  switch (kind) {
    case "external":
      return "external proof";
    case "dogfood":
      return "dogfood";
    case "sample":
      return "sample";
    case "live":
      return "live";
  }
}

function fallbackMarketingBrief(data: EverydayData): MarketingBrief {
  const deliverables = data.thread.filter((entry) => entry.kind === "deliverable").length;
  const connectedChannels = data.connectors.filter((connector) => connector.status === "connected");
  const pendingChannels = data.connectors.filter((connector) => connector.status === "pending");
  const blockedChannels = data.connectors.filter(
    (connector) => connector.status === "coming_soon",
  );
  const workingAgents = data.room.filter((lane) => lane.status === "working").length;
  const operatorReady = data.room.some((lane) => lane.status === "codex");
  const liveReceipts = data.transparency.length;
  const pendingDecisions = data.approvals.length;
  const hasBrief = data.thread.length > 0;
  const hasExternalReceipts = liveReceipts > 0;
  const blockedChannelCount = Math.max(data.connectors.length - connectedChannels.length, 0);
  const shippedWork = deliverables + liveReceipts;
  return {
    mode: "live",
    headline:
      hasBrief || pendingDecisions || hasExternalReceipts
        ? "Live CMO readout from this workspace: work in motion, decisions waiting, channel truth, and proof gaps."
        : "No measurable marketing work yet. Start the room and this brief should fill with live proof, not sample traction.",
    executiveSummary: [
      {
        label: "work shipped today",
        value: String(shippedWork),
        detail: liveReceipts > 0 ? String(liveReceipts) + " external receipt(s)" : String(deliverables) + " draft artifact(s)",
        tone: shippedWork > 0 ? (liveReceipts > 0 ? "good" : "warn") : "bad",
        proof: liveReceipts > 0 ? "transparency receipt log" : deliverables > 0 ? "workspace thread deliverables" : "no work receipts yet",
      },
      {
        label: "pipeline moved",
        value: compactCount(data.northStar.customers),
        detail: data.northStar.revenue,
        tone: data.northStar.customers > 0 ? "good" : "bad",
        proof: "workspace north-star row",
      },
      {
        label: "approvals waiting",
        value: String(pendingDecisions),
        detail: pendingDecisions > 0 ? "owner decision needed" : "no owner queue",
        tone: pendingDecisions > 0 ? "warn" : "neutral",
        proof: "workspace approval queue",
      },
      {
        label: "blocked channels",
        value: String(blockedChannelCount),
        detail: connectedChannels.length > 0 ? String(connectedChannels.length) + " usable" : "no live acquisition channel",
        tone: blockedChannelCount > 0 ? "bad" : "good",
        proof: "workspace connector catalog",
      },
    ],
    sinceLastCheckIn: dashboardChangesSinceLastCheckIn(data, {
      hasBrief,
      hasExternalReceipts,
      pendingDecisions,
    }),
    goal: {
      label: "customer goal",
      target: data.northStar.customers > 0 ? String(data.northStar.customers) : "not set",
      current: `${compactCount(data.northStar.customers)} customers`,
      pace:
        data.northStar.trend === "up"
          ? "moving"
          : hasBrief || pendingDecisions
            ? "work started; conversion not proven"
            : "no acquisition pace yet",
      confidence: data.northStar.customers > 0 ? "medium" : hasBrief || pendingDecisions ? "medium" : "low",
    },
    metrics: [
      {
        label: "customers",
        value: compactCount(data.northStar.customers),
        detail: data.northStar.revenue,
        tone: data.northStar.customers > 0 ? "good" : "bad",
        proofKind: "live",
        proof: "workspace north-star row",
      },
      {
        label: "team lanes",
        value: String(data.room.length),
        detail: workingAgents > 0 ? `${workingAgents} actively working` : "standing by",
        tone: workingAgents > 0 ? "good" : "neutral",
        proofKind: "live",
        proof: "workspace agent lane state",
      },
      {
        label: "channels live",
        value: String(connectedChannels.length),
        detail:
          pendingChannels.length > 0
            ? `${pendingChannels.length} pending verification`
            : blockedChannels.length > 0
              ? `${blockedChannels.length} blocked or not live`
              : "no connector blockers",
        tone: connectedChannels.length > 0 ? "good" : "bad",
        proofKind: "live",
        proof: "workspace connector catalog",
      },
      {
        label: "approvals",
        value: String(pendingDecisions),
        detail: pendingDecisions > 0 ? "waiting on owner decisions" : "nothing waiting",
        tone: pendingDecisions > 0 ? "warn" : "neutral",
        proofKind: "live",
        proof: "workspace approval queue",
      },
      {
        label: "assets shipped",
        value: String(deliverables),
        detail: "thread deliverables only",
        tone: deliverables > 0 ? "warn" : "neutral",
        proofKind: "live",
        proof: "workspace thread deliverables",
      },
      {
        label: "receipts",
        value: String(liveReceipts),
        detail: "external action log",
        tone: hasExternalReceipts ? "good" : "neutral",
        proofKind: hasExternalReceipts ? "external" : "live",
        proof: hasExternalReceipts ? "transparency receipt log" : "no external receipts yet",
      },
    ],
    rankedWork: rankedAgentWork(data, {
      deliverables,
      liveReceipts,
      connectedChannels: connectedChannels.length,
      pendingDecisions,
      hasBrief,
    }),
    capacity: [
      {
        label: "active campaign lanes",
        value: hasBrief ? "1 / 1" : "0 / 1",
        detail: hasBrief ? "upgrade when a second lane queues" : "brief one campaign before upgrading",
        tone: hasBrief ? "warn" : "neutral",
        proof: hasBrief ? "workspace thread has active brief" : "no active brief",
      },
      {
        label: "agent seats used",
        value: String(data.room.length) + " / 3",
        detail: data.room.length > 3 ? "team shape exceeds starter seat limit" : "inside starter team limit",
        tone: data.room.length > 3 ? "warn" : "neutral",
        proof: "workspace agent lane state",
      },
      {
        label: "monthly work cap",
        value: data.northStar.revenue + " / $200",
        detail: data.northStar.revenue === "$0" ? "no paid work/spend to cap yet" : "compare revenue/spend before upgrade",
        tone: data.northStar.revenue === "$0" ? "neutral" : "warn",
        proof: "workspace north-star revenue row",
      },
    ],
    funnel: [
      {
        label: "briefed",
        count: hasBrief ? "1" : "0",
        detail: hasBrief ? "workspace thread has activity" : "no brief received",
        tone: hasBrief ? "good" : "neutral",
      },
      {
        label: "assets",
        count: String(deliverables),
        detail: "thread deliverables",
        tone: deliverables > 0 ? "warn" : "neutral",
      },
      {
        label: "approved",
        count: String(pendingDecisions),
        detail: pendingDecisions > 0 ? "owner decisions waiting" : "nothing queued",
        tone: pendingDecisions > 0 ? "warn" : "neutral",
      },
      {
        label: "sent",
        count: String(liveReceipts),
        detail: "external receipts",
        tone: hasExternalReceipts ? "good" : "bad",
      },
      {
        label: "won",
        count: compactCount(data.northStar.customers),
        detail: data.northStar.revenue,
        tone: data.northStar.customers > 0 ? "good" : "bad",
      },
    ],
    channels: [
      ...data.connectors.slice(0, 4).map((connector) => ({
        source: connector.name,
        status: connector.status === "connected" ? "live" : connector.status === "pending" ? "needs proof" : connector.status,
        pipeline: connector.status === "connected" ? "usable" : "0 usable conversations",
        conversion: connector.status === "connected" ? "unmeasured" : "blocked",
        spend: "$0",
        next: connector.detail,
      })),
      {
        source: "workspace",
        status: operatorReady ? "operator lane ready" : "operator lane missing",
        pipeline: hasBrief ? "brief active" : "no brief",
        conversion: "—",
        spend: data.northStar.revenue,
        next: "attach lead, revenue, and conversion feeds when the real channel starts",
      },
    ],
    blockers: [
      ...(connectedChannels.length === 0
        ? [{ title: "No live acquisition channel", owner: "Scout", proof: "connector catalog has zero connected channels" }]
        : []),
      ...(hasExternalReceipts
        ? []
        : [{ title: "No external send/revenue receipt", owner: "Echo", proof: "transparency log has zero external receipts" }]),
      ...(data.northStar.customers > 0
        ? []
        : [{ title: "No paying customer proof", owner: "Lens", proof: "north-star customer count is zero" }]),
    ],
    decisions: [
      { title: "Set the customer goal this dashboard should pace against", owner: "You", proof: "no goal row found" },
      ...(pendingDecisions > 0
        ? [{ title: "Clear the pending approval queue", owner: "You", proof: `${pendingDecisions} approval card(s) waiting` }]
        : []),
    ],
    nextActions: [
      {
        title: connectedChannels.length > 0 ? "Measure the first live channel" : "Connect one real acquisition channel",
        owner: "Operator",
        proof: connectedChannels.length > 0 ? "channel is live; conversion is unmeasured" : "no connected channel in catalog",
      },
      {
        title: "Turn the latest room work into an approval-backed artifact",
        owner: "Quill",
        proof: hasBrief ? "thread activity exists" : "no active brief yet",
      },
    ],
    readiness: [
      { label: "auth", status: "ready", proof: "signed-in workspace identity loaded" },
      {
        label: "connectors",
        status: connectedChannels.length > 0 ? "ready" : pendingChannels.length > 0 ? "pending" : "blocked",
        proof:
          connectedChannels.length > 0
            ? `${connectedChannels.length} connector(s) connected`
            : pendingChannels.length > 0
              ? `${pendingChannels.length} connector(s) pending verification`
              : "no connected acquisition channel",
      },
      { label: "first run", status: hasBrief ? "pending" : "blocked", proof: hasBrief ? "thread activity exists; no persisted first-run receipt" : "no first-run receipt" },
      { label: "outbound", status: hasExternalReceipts ? "ready" : "blocked", proof: hasExternalReceipts ? "external receipt exists" : "no real sent-message receipt" },
      { label: "billing", status: data.northStar.revenue === "$0" ? "pending" : "ready", proof: `workspace revenue reads ${data.northStar.revenue}` },
      { label: "observability", status: operatorReady ? "pending" : "blocked", proof: operatorReady ? "operator lane visible; health feed not attached" : "operator lane missing" },
      { label: "legal/trust", status: "pending", proof: "legal state is not part of workspace feed" },
    ],
  };
}

function rankedAgentWork(
  data: EverydayData,
  state: {
    deliverables: number;
    liveReceipts: number;
    connectedChannels: number;
    pendingDecisions: number;
    hasBrief: boolean;
  },
): MarketingBrief["rankedWork"] {
  const latestDeliverable = [...data.thread].reverse().find((entry) => entry.kind === "deliverable");
  const items: MarketingBrief["rankedWork"][number][] = [];
  if (state.liveReceipts > 0) {
    const latestReceipt = data.transparency[data.transparency.length - 1];
    items.push({
      agent: "Operator",
      work: latestReceipt?.action ?? "external work receipt",
      impact: "proved work left the room with a receipt",
      status: "shipped",
      proof: latestReceipt?.receiptLabel ?? latestReceipt?.href ?? "transparency receipt log",
    });
  }
  if (latestDeliverable) {
    items.push({
      agent: latestDeliverable.agent,
      work: latestDeliverable.deliverable.title,
      impact:
        state.connectedChannels > 0
          ? "usable asset ready for a connected channel"
          : "usable asset exists, but distribution is still blocked",
      status: state.pendingDecisions > 0 ? "queued" : "learning",
      proof: latestDeliverable.deliverable.preview,
    });
  }
  if (state.pendingDecisions > 0) {
    items.push({
      agent: "You",
      work: String(state.pendingDecisions) + " approval decision(s)",
      impact: "owner decisions are the fastest path to business movement",
      status: "queued",
      proof: "workspace approval queue",
    });
  }
  if (state.connectedChannels === 0) {
    items.push({
      agent: "Echo",
      work: "real acquisition channel",
      impact: "blocked work cannot create leads until a provider is connected",
      status: "blocked",
      proof: "workspace connector catalog",
    });
  }
  if (items.length > 0) return items.slice(0, 4);
  return [
    {
      agent: "Scout",
      work: "waiting for first source read",
      impact: "no insight or customer movement ranked yet",
      status: "blocked",
      proof: "no thread, approval, or receipt activity",
    },
  ];
}

function dashboardChangesSinceLastCheckIn(
  data: EverydayData,
  state: { hasBrief: boolean; hasExternalReceipts: boolean; pendingDecisions: number },
): readonly MarketingAction[] {
  const latestReceipt = data.transparency[data.transparency.length - 1];
  const latestThread = data.thread[data.thread.length - 1];
  const changes: MarketingAction[] = [];
  if (latestReceipt) {
    changes.push({
      title: latestReceipt.action,
      owner: "Operator",
      proof: latestReceipt.receiptLabel ?? latestReceipt.href,
    });
  }
  if (state.pendingDecisions > 0) {
    changes.push({
      title: state.pendingDecisions + " approval decision(s) waiting",
      owner: "You",
      proof: "approval queue",
    });
  }
  if (latestThread) {
    changes.push({
      title: latestThread.kind === "deliverable" ? latestThread.deliverable.title : latestThread.text,
      owner: latestThread.agent,
      proof: latestThread.at,
    });
  }
  if (changes.length > 0) return changes.slice(0, 3);
  return [
    {
      title: state.hasBrief || state.hasExternalReceipts ? "Workspace has prior activity, but no new delta" : "No measurable workspace change yet",
      owner: "Operator",
      proof: state.hasBrief ? "thread activity exists" : "no thread, approval, or receipt activity",
    },
  ];
}

function BriefActionList({
  actions,
  empty,
}: {
  actions: MarketingBrief["blockers"];
  empty: string;
}): React.JSX.Element {
  if (actions.length === 0) return <p className="everyday-empty__line">{empty}</p>;
  return (
    <ul className="everyday-dashboard__actions">
      {actions.map((action) => (
        <li key={action.title}>
          <strong>{action.title}</strong>
          <span>{action.owner}</span>
          <em>{action.proof}</em>
        </li>
      ))}
    </ul>
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
function SafetyFooter({
  paused,
  onEmergencyStop,
  onResumeFleet,
}: {
  paused: boolean;
  onEmergencyStop?: () => Promise<void> | void;
  onResumeFleet?: () => Promise<void> | void;
}): React.JSX.Element {
  const s = EVERYDAY.safety;
  const [confirming, setConfirming] = useState(false);
  const [localPaused, setLocalPaused] = useState(false);
  const [busy, setBusy] = useState<"stop" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopped = paused || localPaused;

  async function stopFleet(): Promise<void> {
    setBusy("stop");
    setError(null);
    try {
      await onEmergencyStop?.();
      setLocalPaused(true);
      setConfirming(false);
    } catch {
      setError(s.killSwitchError);
    } finally {
      setBusy(null);
    }
  }

  async function resumeFleet(): Promise<void> {
    setBusy("resume");
    setError(null);
    try {
      await onResumeFleet?.();
      setLocalPaused(false);
      setConfirming(false);
    } catch {
      setError(s.killSwitchError);
    } finally {
      setBusy(null);
    }
  }

  const statusText =
    busy === "stop"
      ? s.killSwitchPending
      : busy === "resume"
        ? s.killSwitchResumePending
        : error ?? (stopped ? s.killSwitchEngaged : confirming ? s.killSwitchConfirm : null);

  return (
    <section className="everyday-safety" aria-label={s.killSwitchTitle}>
      <p className="everyday-eyebrow">{s.eyebrow}</p>
      <h2 className="everyday-serif everyday-safety__title">{s.killSwitchTitle}</h2>
      <p className="everyday-safety__body">{s.killSwitchBody}</p>
      {statusText && (
        <p
          className="everyday-safety__status"
          role="status"
          data-state={error ? "error" : stopped ? "stopped" : "ready"}
        >
          {statusText}
        </p>
      )}
      <div className="everyday-safety__action">
        {stopped ? (
          <button
            type="button"
            className="everyday-btn everyday-btn--ghost"
            aria-pressed="true"
            disabled={busy !== null}
            onClick={() => void resumeFleet()}
          >
            {s.killSwitchResume}
          </button>
        ) : confirming ? (
          <>
            <button
              type="button"
              className="everyday-btn everyday-btn--stop"
              disabled={busy !== null}
              onClick={() => void stopFleet()}
            >
              {s.killSwitchAction}
            </button>
            <button
              type="button"
              className="everyday-btn everyday-btn--ghost"
              disabled={busy !== null}
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
            >
              {s.killSwitchCancel}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="everyday-btn everyday-btn--ghost"
            aria-pressed="false"
            disabled={busy !== null}
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
  onConnectorConnect,
  imessageStatus,
  onSaveIMessageRecipient,
  onTestIMessageRecipient,
  onDeleteIMessageRecipient,
  onStartRoom,
  onEmergencyStop,
  onResumeFleet,
  operatorPacketForGoal,
  dashboardFirst = false,
  dashboardOnly = false,
}: {
  data?: EverydayData;
  hour?: number;
  approvalActions?: EverydayApprovalActions;
  onConnectorConnect?: (id: string) => void;
  imessageStatus?: IMessageStatusResponse | null;
  onSaveIMessageRecipient?: (input: { recipient: string; serviceName?: string }) => Promise<void> | void;
  onTestIMessageRecipient?: () => Promise<void> | void;
  onDeleteIMessageRecipient?: () => Promise<void> | void;
  onStartRoom?: (goal: string) => Promise<EverydayRoomLaunchResult | void> | EverydayRoomLaunchResult | void;
  onEmergencyStop?: () => Promise<void> | void;
  onResumeFleet?: () => Promise<void> | void;
  operatorPacketForGoal?: (goal: string) => string;
  dashboardFirst?: boolean;
  dashboardOnly?: boolean;
}): React.JSX.Element {
  const [shipped, setShipped] = useState<readonly string[]>([]);
  const [statuses, setStatuses] = useState<Record<string, EverydayDecisionStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [room, setRoom] = useState<readonly AgentLane[]>(data.room);
  const [localThread, setLocalThread] = useState<readonly ThreadEntry[]>([]);
  const [operatorPacket, setOperatorPacket] = useState<string | null>(null);
  const pending = data.approvals.filter((c) => !shipped.includes(c.id));
  const greeting = EVERYDAY.greeting(data.memberName, partOfDay(hour));
  const thread = localThread.length > 0 ? localThread : data.thread;

  function startRoom(goal: string): void {
    setOperatorPacket(operatorPacketForGoal?.(goal) ?? null);
    const userEntry: ThreadEntry = {
      id: "local-" + Date.now(),
      kind: "agent-line",
      agent: data.memberName,
      at: EVERYDAY.room.chatLabel,
      text: goal,
    };
    setLocalThread((entries) => [...entries, userEntry]);

    const showAcceptedRoom = (result?: EverydayRoomLaunchResult | void): void => {
      const notices = result?.notices ?? [];
      setRoom(defaultAgentRoom(goal));
      setLocalThread((entries) => [
        ...entries,
        {
          id: "room-" + Date.now(),
          kind: "agent-line",
          agent: "Scout",
          at: "just now",
          text: "Reading " + goal + " and lining up the first useful marketing moves.",
        },
        {
          id: "codex-" + Date.now(),
          kind: "agent-line",
          agent: "Operator",
          at: "ready",
          text: "I can take product/code handoffs once the team agrees what should ship.",
        },
        ...notices.map((notice, index): ThreadEntry => ({
          id: "room-notice-" + Date.now() + "-" + index,
          kind: "agent-line",
          agent: "Operator",
          at: "channels",
          text: notice,
        })),
      ]);
    };

    if (!onStartRoom) {
      showAcceptedRoom();
      return;
    }

    const showBlockedRoom = (err: unknown): void => {
      setLocalThread((entries) => [
        ...entries,
        {
          id: "room-error-" + Date.now(),
          kind: "agent-line",
          agent: "Operator",
          at: "blocked",
          text: err instanceof Error ? err.message : "I could not start the team room run.",
        },
      ]);
    };

    try {
      Promise.resolve(onStartRoom(goal)).then(showAcceptedRoom).catch(showBlockedRoom);
    } catch (err) {
      showBlockedRoom(err);
    }
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
      <main className={dashboardOnly ? "everyday-shell__main everyday-shell__main--dashboard" : "everyday-shell__main"}>
        {dashboardFirst && (
          <WorkSummary data={{ ...data, room, thread, approvals: pending }} />
        )}
        {!dashboardOnly && (
          <>
            <GroupChatHero
              greeting={greeting}
              lanes={room}
              thread={thread}
              memberName={data.memberName}
              onSubmit={startRoom}
              operatorPacket={operatorPacket}
              imessageStatus={imessageStatus}
            />
            {!dashboardFirst && (
              <WorkSummary data={{ ...data, room, thread, approvals: pending }} />
            )}
            <ConnectorSetup
              connectors={data.connectors}
              onConnect={onConnectorConnect}
              imessageStatus={imessageStatus}
              onSaveIMessageRecipient={onSaveIMessageRecipient}
              onTestIMessageRecipient={onTestIMessageRecipient}
              onDeleteIMessageRecipient={onDeleteIMessageRecipient}
            />
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
            <SafetyFooter
              paused={data.fleetPaused}
              onEmergencyStop={onEmergencyStop}
              onResumeFleet={onResumeFleet}
            />
          </>
        )}
      </main>
    </div>
  );
}
