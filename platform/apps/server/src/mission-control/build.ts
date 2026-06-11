/**
 * Live mission control (#147, ADR-0147 §6 / slice 4). A **pure** builder over the #25 live-session
 * list: derive each session's elapsed time and an *estimated* spend, plus a fleet roll-up. The
 * platform records no per-session cost (#71 aggregates compute per tenant window), so spend is
 * `ceil(elapsedMinutes) × the tenant's compute rate` — labeled an estimate. No IO, no wall-clock (the
 * service injects `now`), so it is fully unit-testable.
 */

export type LiveStatus = "provisioning" | "running" | "completed" | "failed" | "timeout" | "idle_reaped" | "canceled";

/** One live session as the engine reads it (the workspace-scoped repo row). */
export interface MissionSessionInput {
  id: string;
  channelId: string;
  agentMemberId: string;
  status: LiveStatus;
  createdAt: Date;
  startedAt: Date | null;
  progressAt: Date;
}

/** One live session as the console renders it. */
export interface LiveSessionView {
  id: string;
  channelId: string;
  agentMemberId: string;
  status: LiveStatus;
  elapsedMs: number;
  estimatedCostCents: number;
  startedAt: string | null;
  progressAt: string;
}

export interface MissionControl {
  sessions: LiveSessionView[];
  count: number;
  totalEstimatedCostCents: number;
  /** The per-minute compute rate used for the estimate (0 = unknown ⇒ all estimates 0). */
  rateCentsPerMinute: number;
  /** Surfaced so the UI can label spend as an estimate, not a billed figure. */
  costIsEstimate: true;
}

function elapsedMs(session: MissionSessionInput, now: Date): number {
  const anchor = (session.startedAt ?? session.createdAt).getTime();
  return Math.max(0, now.getTime() - anchor);
}

export function buildMissionControl(input: {
  sessions: MissionSessionInput[];
  rateCentsPerMinute: number;
  now: Date;
}): MissionControl {
  const rate = Math.max(0, input.rateCentsPerMinute);
  const sessions: LiveSessionView[] = input.sessions.map((s) => {
    const ms = elapsedMs(s, input.now);
    const estimatedCostCents = Math.ceil(ms / 60_000) * rate;
    return {
      id: s.id,
      channelId: s.channelId,
      agentMemberId: s.agentMemberId,
      status: s.status,
      elapsedMs: ms,
      estimatedCostCents,
      startedAt: s.startedAt ? s.startedAt.toISOString() : null,
      progressAt: s.progressAt.toISOString(),
    };
  });
  return {
    sessions,
    count: sessions.length,
    totalEstimatedCostCents: sessions.reduce((sum, s) => sum + s.estimatedCostCents, 0),
    rateCentsPerMinute: rate,
    costIsEstimate: true,
  };
}
