import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client.js";
import type { PublicSupportTicketStatusDto } from "../api/types.js";

function fmt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function useParams(): { wid: string; ticket: string; sourceRef: string } {
  return useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      wid: params.get("wid") ?? "",
      ticket: params.get("ticket") ?? "",
      sourceRef: params.get("sourceRef") ?? "",
    };
  }, []);
}

export function SupportTicketStatus(): React.JSX.Element {
  const params = useParams();
  const [status, setStatus] = useState<PublicSupportTicketStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.wid || !params.ticket || !params.sourceRef) {
      setError("Missing ticket link details.");
      return;
    }
    let cancelled = false;
    api
      .getPublicSupportTicketStatus(params.wid, params.ticket, params.sourceRef)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.status === 404
            ? "Ticket not found."
            : "Could not load ticket status.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [params.sourceRef, params.ticket, params.wid]);

  return (
    <main className="support-status">
      <section className="support-status__panel">
        <p className="support-status__eyebrow">Support ticket</p>
        <h1>Status {status ? status.status.replace("_", " ") : ""}</h1>
        {error ? <p className="support-status__error">{error}</p> : null}
        {!error && !status ? <p>Loading ticket status...</p> : null}
        {status ? (
          <>
            <dl className="support-status__facts">
              <div>
                <dt>Ticket</dt>
                <dd>{status.ticketId}</dd>
              </div>
              <div>
                <dt>Expected response</dt>
                <dd>{fmt(status.slaDueAt)}</dd>
              </div>
              <div>
                <dt>SLA</dt>
                <dd>
                  {status.slaBreached ? "Past due" : status.firstResponseSlaMinutes + " minutes"}
                </dd>
              </div>
              <div>
                <dt>Response</dt>
                <dd>{status.responseState.replaceAll("_", " ")}</dd>
              </div>
            </dl>
            <ol className="support-status__timeline">
              {status.events.map((event) => (
                <li key={event.type + "-" + event.at}>
                  <span>{fmt(event.at)}</span>
                  <strong>{event.type.replaceAll("_", " ")}</strong>
                  {event.detail ? <p>{event.detail}</p> : null}
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </section>
    </main>
  );
}
