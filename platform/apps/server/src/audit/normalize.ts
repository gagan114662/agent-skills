/**
 * The owner-visible audit trail (#147, ADR-0147 §5 / slice 3). A **pure** merge of three sources the
 * platform already records append-only and tenant-scoped — #13 approval requests, #147 automation
 * runs, and #123 marketing-task launches — into one time-sorted feed of *who/what/when/gated-by*.
 * There is no generic event store and we add none: the audit trail is a read model, so it can never
 * drift from state and needs no migration of its own. No IO here (the service supplies the rows + a
 * label resolver); fully unit-testable.
 */

/** A #13 approval request, projected to the audit shape (the human-gate source). */
export interface ApprovalAuditRow {
  id: string;
  requesterMemberId: string;
  actionType: string;
  summary: string;
  status: string;
  createdAt: Date;
}

/** A #147 automation run, projected to the audit shape. */
export interface RunAuditRow {
  id: string;
  automationId: string;
  trigger: string;
  status: string;
  reason: string;
  task: string;
  createdAt: Date;
}

/** A #123 marketing-task launch, projected to the audit shape. */
export interface LaunchAuditRow {
  id: string;
  department: string;
  agentMemberId: string;
  kind: string;
  task: string;
  status: string;
  createdByMemberId: string | null;
  createdAt: Date;
}

/** A #928 external-credential lifecycle event, projected to the audit shape. */
export interface CredentialAuditRow {
  id: string;
  serviceKey: string;
  action: "connected" | "revoked";
  actorMemberId: string | null;
  fingerprint: string | null;
  envKeys: string[];
  scopes: string[];
  createdAt: Date;
}

/** One normalized audit event — the unit the pane renders. */
export interface AuditEvent {
  at: string;
  /** A dotted kind, e.g. `approval.external.send`, `automation.schedule`, `agent.mention`. */
  kind: string;
  source: "approval" | "automation" | "agent" | "credential";
  actorMemberId: string | null;
  actorLabel: string;
  summary: string;
  /** What gated the action: the human approval queue, the venture+budget caps, or nothing. */
  gatedBy: "approval" | "venture+budget" | "none";
  status: string;
  /** The source row id (so the UI can deep-link). */
  ref: string;
}

export interface AuditInput {
  approvals: ApprovalAuditRow[];
  runs: RunAuditRow[];
  launches: LaunchAuditRow[];
  credentials?: CredentialAuditRow[];
  /** Resolve a member's display label (null/unknown → "system"). */
  labelFor: (memberId: string | null) => string;
  /** Max events returned (newest first). Default 200. */
  limit?: number;
}

function snippet(text: string, max = 80): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Merge + sort the three sources into one newest-first audit feed, capped at `limit`. */
export function normalizeAuditEvents(input: AuditInput): AuditEvent[] {
  const events: AuditEvent[] = [];

  for (const a of input.approvals) {
    events.push({
      at: a.createdAt.toISOString(),
      kind: `approval.${a.actionType}`,
      source: "approval",
      actorMemberId: a.requesterMemberId,
      actorLabel: input.labelFor(a.requesterMemberId),
      summary: a.summary || `${a.actionType} requested`,
      gatedBy: "approval",
      status: a.status,
      ref: a.id,
    });
  }

  for (const r of input.runs) {
    events.push({
      at: r.createdAt.toISOString(),
      kind: `automation.${r.trigger}`,
      source: "automation",
      actorMemberId: null,
      actorLabel: "automation",
      summary:
        r.status === "launched"
          ? `Automation launched${r.task ? `: ${snippet(r.task)}` : ""}`
          : `Automation ${r.status}${r.reason ? ` (${r.reason})` : ""}`,
      gatedBy: "venture+budget",
      status: r.status,
      ref: r.id,
    });
  }

  for (const l of input.launches) {
    events.push({
      at: l.createdAt.toISOString(),
      kind: `agent.${l.kind}`,
      source: "agent",
      actorMemberId: l.agentMemberId,
      actorLabel: input.labelFor(l.agentMemberId),
      summary: `${l.department} agent launched${l.task ? `: ${snippet(l.task)}` : ""}`,
      gatedBy: "venture+budget",
      status: l.status,
      ref: l.id,
    });
  }

  for (const c of input.credentials ?? []) {
    const scopeText = c.scopes.length ? ` scopes=${c.scopes.join(",")}` : "";
    const envText = c.envKeys.length ? ` env=${c.envKeys.join(",")}` : "";
    events.push({
      at: c.createdAt.toISOString(),
      kind: `credential.${c.action}`,
      source: "credential",
      actorMemberId: c.actorMemberId,
      actorLabel: input.labelFor(c.actorMemberId),
      summary: `${c.serviceKey} credentials ${c.action}${scopeText}${envText}`,
      gatedBy: "none",
      status: c.action,
      ref: c.id,
    });
  }

  events.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  return events.slice(0, input.limit ?? 200);
}
