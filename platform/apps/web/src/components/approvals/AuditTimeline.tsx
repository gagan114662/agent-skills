/** The append-only audit chain for a request (#13): requested → approved/rejected/expired →
 * executed/failed, rendered in order with actor and any detail. Read from GET /approvals/:rid/events. */
import type { ApprovalEventDto } from "@reload/shared";
import { useAppState } from "../../store/StoreContext.js";
import { authorLabel } from "../../store/store.js";
import { formatAge } from "./ttl.js";

const LABEL: Record<ApprovalEventDto["type"], string> = {
  requested: "Requested",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
  executed: "Executed",
  failed: "Failed",
};

/** A short, human-readable detail line for an event (reason / error / result), if any. */
function detailText(event: ApprovalEventDto): string | null {
  const d = event.detail;
  if (typeof d.reason === "string" && d.reason) return d.reason;
  if (typeof d.error === "string" && d.error) return d.error;
  const keys = Object.keys(d);
  return keys.length > 0 ? JSON.stringify(d) : null;
}

export function AuditTimeline({
  events,
  now = Date.now(),
}: {
  events: ApprovalEventDto[];
  now?: number;
}): React.JSX.Element {
  const { directory } = useAppState();
  if (events.length === 0)
    return <p className="timeline__empty">Nothing's happened here yet — the trail starts on the first decision.</p>;
  return (
    <ol className="timeline">
      {events.map((ev) => {
        const detail = detailText(ev);
        return (
          <li key={ev.id} className="timeline__event" data-type={ev.type}>
            <span className={`timeline__dot timeline__dot--${ev.type}`} aria-hidden="true" />
            <div className="timeline__body">
              <span className="timeline__type">{LABEL[ev.type]}</span>
              <span className="timeline__actor">
                {ev.actorMemberId ? authorLabel(directory, ev.actorMemberId) : "system"}
              </span>
              <span className="timeline__when">{formatAge(ev.createdAt, now)}</span>
              {detail && <p className="timeline__detail">{detail}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
