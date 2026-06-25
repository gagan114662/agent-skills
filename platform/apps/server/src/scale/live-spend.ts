/**
 * In-memory live session spend registry (#926). Durable usage remains in tenant_usage at teardown; this
 * registry is the realtime dashboard companion so owners can see which active session is burning budget
 * before the final compute receipt lands.
 */

export interface LiveSessionSpend {
  sessionId: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
  startedAtMs: number;
  elapsedSeconds: number;
  estimatedCostCents: number;
  budgetCents: number;
  utilization: number | null;
  threshold: SpendAlertThreshold | null;
}

export type SpendAlertThreshold = 50 | 75 | 90 | 100;

export class LiveSpendRegistry {
  private readonly rows = new Map<string, LiveSessionSpend>();

  upsert(row: LiveSessionSpend): void {
    this.rows.set(row.sessionId, row);
  }

  remove(sessionId: string): void {
    this.rows.delete(sessionId);
  }

  list(workspaceId: string): LiveSessionSpend[] {
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId)
      .sort((a, b) => b.estimatedCostCents - a.estimatedCostCents);
  }
}

export const liveSpendRegistry = new LiveSpendRegistry();
