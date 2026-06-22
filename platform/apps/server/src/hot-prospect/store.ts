/**
 * Persistence seam for hot-prospect alerting (issue #622). The narrow interface the service writes fired
 * alerts through and reads the last-alert time back from — interface only, no IO — so the service is
 * unit-tested with the in-memory store and the production binding is the self-managed Postgres store in
 * `hot-prospect/default.ts` (the #17 pure-decision + injected-seam pattern).
 *
 * The store's load-bearing job is COOLDOWN DEDUP: {@link AlertStore.lastAlertAt} lets the service avoid
 * re-alerting the same prospect every scan while their activity stays hot. Every method is workspace-scoped
 * (the `workspaceId` argument / a column on every row) — the #3 IDOR boundary.
 */

import type { NotificationRoute } from "./types.js";

/** A persisted record of a fired alert. Plain DATA — the service never trusts a stored field to choose an action. */
export interface AlertRecord {
  id: string;
  workspaceId: string;
  prospectId: string;
  /** The intent score at firing. */
  score: number;
  /** The headline reason. */
  reason: string;
  /** Routes the alert was queued for. */
  routes: NotificationRoute[];
  /** The #13 approval the outbound notification was parked behind — proof the send is gated. */
  approvalRequestId: string | null;
  /** ISO instant the alert was raised. */
  raisedAt: string;
}

/** Everything needed to persist one fired alert; the service assigns no id (the store does). */
export interface NewAlertRecord {
  workspaceId: string;
  prospectId: string;
  score: number;
  reason: string;
  routes: NotificationRoute[];
  approvalRequestId: string | null;
  raisedAt: string;
}

export interface AlertStore {
  /** ISO of the most recent alert for a prospect, or null when none — drives cooldown dedup. */
  lastAlertAt(workspaceId: string, prospectId: string): Promise<string | null>;
  /** Persist a fired alert and return the stored record (with its assigned id). */
  record(input: NewAlertRecord): Promise<AlertRecord>;
  /** Recent alerts for a workspace, newest first (read-back for a UI / digest). `limit` caps the count. */
  recent(workspaceId: string, limit?: number): Promise<AlertRecord[]>;
}

function cloneRecord(r: AlertRecord): AlertRecord {
  return { ...r, routes: [...r.routes] };
}

/**
 * In-memory {@link AlertStore} for unit tests and the default (disabled) wiring. Deterministic: ids are a
 * monotonic counter (`alert-<n>`), so a test never depends on a uuid. Reads return copies so a caller cannot
 * mutate stored state through the result.
 */
export class InMemoryAlertStore implements AlertStore {
  private readonly records: AlertRecord[] = [];
  private seq = 0;

  async lastAlertAt(workspaceId: string, prospectId: string): Promise<string | null> {
    let latest: string | null = null;
    for (const r of this.records) {
      if (r.workspaceId !== workspaceId || r.prospectId !== prospectId) continue;
      if (latest === null || Date.parse(r.raisedAt) > Date.parse(latest)) latest = r.raisedAt;
    }
    return latest;
  }

  async record(input: NewAlertRecord): Promise<AlertRecord> {
    const rec: AlertRecord = {
      id: `alert-${++this.seq}`,
      workspaceId: input.workspaceId,
      prospectId: input.prospectId,
      score: input.score,
      reason: input.reason,
      routes: [...input.routes],
      approvalRequestId: input.approvalRequestId,
      raisedAt: input.raisedAt,
    };
    this.records.push(rec);
    return cloneRecord(rec);
  }

  async recent(workspaceId: string, limit = 50): Promise<AlertRecord[]> {
    return this.records
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => Date.parse(b.raisedAt) - Date.parse(a.raisedAt) || b.id.localeCompare(a.id))
      .slice(0, Math.max(0, limit))
      .map(cloneRecord);
  }
}
