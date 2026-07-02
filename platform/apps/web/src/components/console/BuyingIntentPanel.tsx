import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client.js";
import type { IntentLeadDto } from "../../api/types.js";

function statusLabel(status: IntentLeadDto["status"]): string {
  return status
    .split("_")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function categoryLabel(category: IntentLeadDto["intentCategory"]): string {
  switch (category) {
    case "active_purchase_research":
      return "Buying research";
    case "pain_expression":
      return "Pain";
    case "competitor_churn":
      return "Switching";
    case "noise":
      return "Noise";
  }
}

function preview(value: string): string {
  return value.length > 120 ? value.slice(0, 117) + "..." : value;
}

export function BuyingIntentPanel({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [leads, setLeads] = useState<IntentLeadDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    setError(null);
    try {
      const res = await api.intentScanner.listLeads(workspaceId, { limit: 20 });
      setLeads(res.leads);
      setSelectedId((prev) => prev ?? res.leads[0]?.id ?? null);
    } catch {
      setError("Buying-intent leads are not available right now.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let live = true;
    setLoading(true);
    void load();
    const timer = window.setInterval(() => {
      if (live) void load();
    }, 30_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [workspaceId]);

  const selected = useMemo(
    () => leads.find((lead) => lead.id === selectedId) ?? leads[0] ?? null,
    [leads, selectedId],
  );
  const pendingCount = leads.filter((lead) => lead.status === "reply_pending_approval").length;

  async function scanNow(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.intentScanner.scan(workspaceId);
      await load();
    } catch {
      setError("Could not run the scanner right now.");
    } finally {
      setBusy(false);
    }
  }

  async function queueReply(): Promise<void> {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { lead } = await api.intentScanner.queueReply(workspaceId, selected.id);
      setLeads((prev) => prev.map((item) => (item.id === lead.id ? lead : item)));
      setSelectedId(lead.id);
    } catch {
      setError("Could not queue that reply for approval.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="inbound-leads" aria-labelledby="buying-intent-title">
      <div className="inbound-leads__head">
        <div>
          <p className="inbound-leads__eyebrow">Buying intent</p>
          <h2 id="buying-intent-title" className="inbound-leads__title">Reddit and X leads</h2>
        </div>
        <div
          className="inbound-leads__counts"
          aria-label={String(leads.length) + " leads, " + pendingCount + " pending approval"}
        >
          <span>{leads.length} leads</span>
          <span>{pendingCount} pending</span>
        </div>
      </div>

      {error && <p className="inbound-leads__error" role="alert">{error}</p>}

      <div className="inbound-leads__prooflinks">
        <button className="btn btn--ghost btn--small" type="button" disabled={busy} onClick={() => void scanNow()}>
          {busy ? "Working..." : "Scan now"}
        </button>
      </div>

      {loading ? (
        <p className="inbound-leads__empty">Loading buying-intent leads...</p>
      ) : leads.length === 0 ? (
        <p className="inbound-leads__empty">No scored Reddit or X leads yet.</p>
      ) : (
        <div className="inbound-leads__grid">
          <ul className="inbound-leads__list" aria-label="Buying-intent leads">
            {leads.map((lead) => {
              const active = lead.id === selected?.id;
              return (
                <li key={lead.id}>
                  <button
                    type="button"
                    className={"inbound-leads__row" + (active ? " inbound-leads__row--active" : "")}
                    onClick={() => setSelectedId(lead.id)}
                  >
                    <span className="inbound-leads__rowtop">
                      <b>{lead.title}</b>
                      <em className="inbound-leads__status">{lead.intentScore}</em>
                    </span>
                    <span className="inbound-leads__meta">
                      {lead.source.toUpperCase()} - {lead.community ?? "public thread"} - {categoryLabel(lead.intentCategory)}
                    </span>
                    <span className="inbound-leads__preview">{preview(lead.bodyExcerpt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          {selected && (
            <article className="inbound-leads__detail" aria-label="Buying-intent lead detail">
              <div className="inbound-leads__detailhead">
                <div>
                  <h3>{selected.title}</h3>
                  <p>{selected.authorLabel ?? selected.community ?? selected.source}</p>
                </div>
                <span className="inbound-leads__status">{statusLabel(selected.status)}</span>
              </div>
              <dl className="inbound-leads__facts">
                <div><dt>Score</dt><dd>{selected.intentScore}</dd></div>
                <div><dt>Source</dt><dd>{selected.source.toUpperCase()}</dd></div>
                <div><dt>Type</dt><dd>{categoryLabel(selected.intentCategory)}</dd></div>
                <div><dt>Approval</dt><dd>{selected.approvalRequestId ?? "not queued"}</dd></div>
              </dl>
              <p className="inbound-leads__message">{selected.evidence[0]?.quote ?? selected.bodyExcerpt}</p>
              <section className="inbound-leads__proof" aria-label="Draft reply">
                <div className="inbound-leads__proofhead">
                  <h4>Draft reply</h4>
                  <span className="inbound-leads__prooflinks">
                    <a href={selected.url}>Open thread</a>
                    <button
                      className="btn btn--ghost btn--small"
                      type="button"
                      disabled={busy || !!selected.approvalRequestId}
                      onClick={() => void queueReply()}
                    >
                      {selected.approvalRequestId ? "In approval queue" : "Queue approval"}
                    </button>
                  </span>
                </div>
                <p className="inbound-leads__message">{selected.draftReply}</p>
              </section>
            </article>
          )}
        </div>
      )}
    </section>
  );
}
