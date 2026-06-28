/**
 * Inbound lead queue (#898): the console's owner-facing notification + lifecycle surface for public hand-
 * raises captured by `POST /inbound/leads`. It reads the durable lead API, highlights 24h SLA breaches,
 * shows the full message, and lets the owner assign / set next action / move new → working → converted or
 * archived without creating duplicate Reach enrolments.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client.js";
import type { InboundLeadDto, InboundLeadStatus } from "../../api/types.js";
import { CONTACT } from "../../brand.js";

const STATUSES: InboundLeadStatus[] = ["new", "working", "converted", "archived"];

function formatWhen(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

function statusLabel(status: InboundLeadStatus): string {
  return status[0]!.toUpperCase() + status.slice(1);
}

function preview(message: string): string {
  return message.length > 96 ? `${message.slice(0, 93)}...` : message;
}

function hasRealEmail(email: string): boolean {
  return !/@example\.(com|net|org|test)$/i.test(email.trim()) && !/\.example\.test$/i.test(email.trim());
}

function trackedBookingHref(lead: InboundLeadDto): string {
  if (!lead.trackingRef) return CONTACT.bookingHref;
  const separator = CONTACT.bookingHref.includes("?") ? "&" : "?";
  return `${CONTACT.bookingHref}${separator}ref=${encodeURIComponent(lead.trackingRef)}`;
}

function trackedBookingProofUrl(lead: InboundLeadDto): string {
  return new URL(trackedBookingHref(lead), "https://ipop.ai").toString();
}

function proofDraftHref(lead: InboundLeadDto): string | null {
  if (!lead.trackingRef || !hasRealEmail(lead.email)) return null;
  const proof = {
    prospectSource: {
      kind: "csv_import",
      importedCount: 1,
      fabricatedCount: 0,
      trackingRef: lead.trackingRef,
      sampleEmails: [lead.email],
    },
    outboundDelivery: {
      channel: "email_postmark",
      provider: "postmark",
      recipient: lead.email,
      approvalRequestId: "",
      trackingRef: lead.trackingRef,
      receipt: {
        source: "production_readback",
        externalRef: "",
        observedAt: "",
        detail: { provider: "postmark" },
      },
    },
    reply: {
      providerThreadId: "",
      replyMessageId: "",
      replyFrom: lead.email,
      visibleInLeadTimeline: false,
      visibleInInbox: false,
    },
    inboundRoute: {
      leadId: lead.id,
      leadEmail: lead.email,
      rule: "inbound_lead",
      trackingRef: lead.trackingRef,
      autoQualified: lead.status === "working" || lead.status === "converted",
      acknowledged: false,
      routedToCadence: lead.status === "working" || lead.status === "converted",
    },
    booking: {
      url: trackedBookingProofUrl(lead),
      surface: "landing_form",
      trackingRef: lead.trackingRef,
    },
  };
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(proof, null, 2))}`;
}

function proofStepClass(done: boolean): string {
  return `inbound-leads__proofstep${done ? " inbound-leads__proofstep--done" : ""}`;
}

export function InboundLeadsPanel(): React.JSX.Element {
  const [leads, setLeads] = useState<InboundLeadDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assignee, setAssignee] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getInboundLeads({ limit: 50 });
      setLeads(res.leads);
      setSelectedId((prev) => prev ?? res.leads[0]?.id ?? null);
    } catch {
      setError("Inbound leads are not available right now.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const selected = useMemo(
    () => leads.find((lead) => lead.id === selectedId) ?? leads[0] ?? null,
    [leads, selectedId],
  );
  const selectedProofDraftHref = selected ? proofDraftHref(selected) : null;
  const openCount = leads.filter((lead) => lead.status === "new" || lead.status === "working").length;
  const breachCount = leads.filter((lead) => lead.slaBreached && lead.status !== "converted" && lead.status !== "archived").length;

  useEffect(() => {
    setAssignee(selected?.assigneeMemberId ?? "");
    setNextAction(selected?.nextAction ?? "");
  }, [selected?.id, selected?.assigneeMemberId, selected?.nextAction]);

  async function save(update: { status?: InboundLeadStatus; assign?: boolean }): Promise<void> {
    if (!selected || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { lead } = await api.updateInboundLead(selected.id, {
        status: update.status,
        assigneeMemberId: update.assign ? assignee || null : undefined,
        nextAction: update.assign ? nextAction || null : undefined,
      });
      setLeads((prev) => prev.map((item) => (item.id === lead.id ? lead : item)));
      setSelectedId(lead.id);
    } catch {
      setError("Could not update that lead.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="inbound-leads" aria-labelledby="inbound-leads-title">
      <div className="inbound-leads__head">
        <div>
          <p className="inbound-leads__eyebrow">Inbound leads</p>
          <h2 id="inbound-leads-title" className="inbound-leads__title">Captured hand-raises</h2>
        </div>
        <div className="inbound-leads__counts" aria-label={`${openCount} open, ${breachCount} breached`}>
          <span>{openCount} open</span>
          <span className={breachCount ? "inbound-leads__breach" : ""}>{breachCount} SLA</span>
        </div>
      </div>

      {error && <p className="inbound-leads__error" role="alert">{error}</p>}

      {loading ? (
        <p className="inbound-leads__empty">Loading inbound leads...</p>
      ) : leads.length === 0 ? (
        <p className="inbound-leads__empty">No captured leads yet.</p>
      ) : (
        <div className="inbound-leads__grid">
          <ul className="inbound-leads__list" aria-label="Captured inbound leads">
            {leads.map((lead) => {
              const active = lead.id === selected?.id;
              return (
                <li key={lead.id}>
                  <button
                    type="button"
                    className={`inbound-leads__row${active ? " inbound-leads__row--active" : ""}`}
                    onClick={() => setSelectedId(lead.id)}
                  >
                    <span className="inbound-leads__rowtop">
                      <b>{lead.name ?? lead.email}</b>
                      <em className={`inbound-leads__status inbound-leads__status--${lead.status}`}>{statusLabel(lead.status)}</em>
                    </span>
                    <span className="inbound-leads__meta">{lead.email} · {formatWhen(lead.createdAtMs)}</span>
                    <span className="inbound-leads__preview">{preview(lead.message)}</span>
                    {lead.slaBreached && lead.status !== "converted" && lead.status !== "archived" && (
                      <span className="inbound-leads__sla">24h SLA breached</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {selected && (
            <article className="inbound-leads__detail" aria-label="Lead details">
              <div className="inbound-leads__detailhead">
                <div>
                  <h3>{selected.name ?? selected.email}</h3>
                  <p>{selected.email}</p>
                </div>
                <span className={`inbound-leads__status inbound-leads__status--${selected.status}`}>{statusLabel(selected.status)}</span>
              </div>
              <dl className="inbound-leads__facts">
                <div><dt>Source</dt><dd>{selected.source}</dd></div>
                <div><dt>SLA due</dt><dd>{formatWhen(selected.slaDueAtMs)}</dd></div>
                <div><dt>Reach key</dt><dd>{selected.reachContactKey}</dd></div>
                <div><dt>Tracking ref</dt><dd>{selected.trackingRef ?? "missing"}</dd></div>
              </dl>
              <p className="inbound-leads__message">{selected.message}</p>
              <section className="inbound-leads__proof" aria-labelledby="first-customer-proof-title">
                <div className="inbound-leads__proofhead">
                  <h4 id="first-customer-proof-title">First-customer proof</h4>
                  <span className="inbound-leads__prooflinks">
                    <a href={trackedBookingHref(selected)}>Tracked booking link</a>
                    {selectedProofDraftHref ? (
                      <a href={selectedProofDraftHref} download={`first-customer-proof-${selected.trackingRef}.json`}>
                        Proof JSON draft
                      </a>
                    ) : (
                      <span>Proof draft needs real email + tracking ref</span>
                    )}
                  </span>
                </div>
                <ol className="inbound-leads__proofsteps">
                  <li className={proofStepClass(hasRealEmail(selected.email) && selected.trackingRef !== null)}>
                    <b>Source</b>
                    <span>
                      {hasRealEmail(selected.email) && selected.trackingRef
                        ? `Real lead captured with ${selected.trackingRef}`
                        : "Needs a non-example prospect email and trackingRef"}
                    </span>
                  </li>
                  <li className={proofStepClass(false)}>
                    <b>Delivery</b>
                    <span>Needs approved Postmark production_readback receipt to this email.</span>
                  </li>
                  <li className={proofStepClass(false)}>
                    <b>Reply</b>
                    <span>
                      {selected.respondedAtMs
                        ? `Response recorded ${formatWhen(selected.respondedAtMs)}; verify provider thread visibility.`
                        : "Needs provider reply ingested and visible in the lead timeline."}
                    </span>
                  </li>
                  <li className={proofStepClass(selected.status === "working" || selected.status === "converted")}>
                    <b>Route</b>
                    <span>
                      {selected.status === "working" || selected.status === "converted"
                        ? `Lead is ${selected.status}; keep cadence tied to the same trackingRef.`
                        : "Move to Working after qualification and set the next action."}
                    </span>
                  </li>
                  <li className={proofStepClass(selected.status === "converted")}>
                    <b>Book</b>
                    <span>
                      {selected.status === "converted"
                        ? "Converted; attach the booked-call or trial-start receipt."
                        : "Send the tracked booking/trial link and keep the same trackingRef."}
                    </span>
                  </li>
                </ol>
              </section>
              <label className="inbound-leads__field">
                <span>Assignee member ID</span>
                <input value={assignee} onChange={(e) => setAssignee(e.target.value.trim())} placeholder="Member UUID" />
              </label>
              <label className="inbound-leads__field">
                <span>Next action</span>
                <textarea rows={2} value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="Reply, qualify, book meeting..." />
              </label>
              <div className="inbound-leads__actions" aria-label="Lead actions">
                <button type="button" onClick={() => void save({ assign: true })} disabled={saving}>Save</button>
                {STATUSES.map((status) => (
                  <button
                    type="button"
                    key={status}
                    onClick={() => void save({ status })}
                    disabled={saving || selected.status === status}
                  >
                    {statusLabel(status)}
                  </button>
                ))}
              </div>
            </article>
          )}
        </div>
      )}
    </section>
  );
}
