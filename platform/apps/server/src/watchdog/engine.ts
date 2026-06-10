import type { SessionStatus } from "../db/repositories/agent-sessions.js";
import type { ChannelPoster, SessionLogger } from "../runtime/manager.js";
import { recordWatchdogAction, recordWatchdogTick } from "../observability/metrics.js";
import { decideRevival } from "./decide.js";
import { windowExpired } from "./guards.js";
import { classifyFailure } from "./taxonomy.js";
import { watchdogThresholds, type WatchdogCaps } from "./caps.js";
import type { WatchdogAction } from "./types.js";

/**
 * WatchdogEngine (#105, ADR-0105) — the cross-process supervisor that makes the 24/7 fleet
 * self-healing. Modelled on the #17 AutonomyEngine / #96 VentureEngine: an opt-in periodic timer
 * (default off, started in `index.ts` only when `WATCHDOG_INTERVAL_MS > 0`) whose `tickAll()` lists
 * the fleet's live (non-terminal) sessions, groups them by workspace, and runs each workspace's stale
 * sessions through the pure {@link decideRevival}. Side effects live here; the decision is pure.
 *
 * Gating mirrors the rest of the platform: maintenance (#99) pauses the whole pass BEFORE any DB
 * call; a workspace's #17 kill switch halts its pass; the `watchdog.enabled` config flag is default
 * OFF so an un-opted-in deployment is unchanged. Revival reuses the #92 `AutonomyLauncher` (so it
 * passes the same #71 admission chokepoint), the bound is durable (`watchdog_revivals`), and a
 * hopeless lineage escalates to the #13 approvals queue.
 */

/** A non-terminal session the watchdog is supervising (the work-list item). */
export interface LiveSession {
  id: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
  createdByMemberId: string | null;
  status: SessionStatus;
  /** The session's last proof of progress: `COALESCE(last_heartbeat_at, started_at, created_at)`. */
  progressAt: Date;
}

/** A durable revival lineage (one row in `watchdog_revivals`). */
export interface RevivalRecord {
  id: string;
  workspaceId: string;
  rootSessionId: string;
  /** The latest live replacement session this lineage points at. */
  currentSessionId: string;
  /** Revivals attempted in the current rolling window. */
  revivals: number;
  windowStartedAt: Date;
  lastRevivalAt: Date | null;
  lastErrorClass: string | null;
  status: "active" | "escalated" | "recovered";
}

/** The durable revival store seam (real impl wraps the `watchdog_revivals` repo; tests fake it). */
export interface WatchdogRevivalStore {
  /** The lineage whose current live session is this id, or null for a freshly-detected stall. */
  getByCurrentSession(workspaceId: string, sessionId: string): Promise<RevivalRecord | null>;
  /** Open a lineage for a freshly-detected stalled session. */
  createForRoot(input: {
    workspaceId: string;
    rootSessionId: string;
    errorClass: string;
  }): Promise<RevivalRecord>;
  /** Record a revival: point the lineage at the replacement + bump the count (resetting a stale window). */
  recordRevival(input: {
    id: string;
    newSessionId: string;
    windowMs: number;
    errorClass: string;
    now: Date;
  }): Promise<RevivalRecord>;
  /** Mark the lineage escalated — a human now owns it. */
  markEscalated(id: string): Promise<void>;
}

/** The session-launch surface the watchdog drives — the #92 {@link AutonomyLauncher} satisfies it. */
export interface SessionReviver {
  launch(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    task: string;
    harnessEnv?: Record<string, string>;
  }): Promise<{ id: string }>;
}

/** The #13 escalation seam — enqueue a human approval request for a hopeless lineage. */
export interface WatchdogEscalator {
  escalate(input: {
    workspaceId: string;
    session: LiveSession;
    record: RevivalRecord;
    reason: string;
  }): Promise<{ id: string }>;
}

export interface WatchdogEngineDeps {
  /** The work-list: non-terminal (`provisioning`/`running`) sessions across the fleet. */
  listLiveSessions: () => Promise<LiveSession[]>;
  /** Resolve the per-workspace watchdog caps (config; default OFF). */
  caps: (workspaceId: string) => WatchdogCaps;
  /** The #17 kill switch for a workspace (halts its pass). */
  killSwitch: (workspaceId: string) => Promise<boolean>;
  /** Whether the workspace has met/passed its #71 dollar ceiling (escalate instead of spend). */
  budgetExhausted: (workspaceId: string, now: Date) => Promise<boolean>;
  revivals: WatchdogRevivalStore;
  reviver: SessionReviver;
  /** Finalize the dead/stalled session row (reuses `finalizeSession`). */
  finalizeDead: (sessionId: string, status: SessionStatus) => Promise<void>;
  escalator: WatchdogEscalator;
  /** Optional channel narration (mirrors the autonomy engine's poster). */
  poster?: ChannelPoster;
  /**
   * Optional maintenance-pause check (#99). When it resolves true, `tickAll()` skips the whole pass
   * BEFORE any DB call. Absent ⇒ never paused (unchanged behaviour).
   */
  maintenancePaused?: () => Promise<boolean>;
  logger: SessionLogger;
  /** Clock seam — defaults to `Date.now` based; tests inject a fixed clock. */
  now?: () => Date;
}

export interface AppliedRevival {
  sessionId: string;
  action: WatchdogAction;
  reason: string;
}

export interface WorkspaceTickResult {
  workspaceId: string;
  /** Set when the whole workspace pass was skipped (disabled | kill_switch); else undefined. */
  skipped?: "disabled" | "kill_switch";
  actions: AppliedRevival[];
}

/** Compose the prompt handed to the revived session (data, never argv). */
function composeRevivalTask(session: LiveSession): string {
  return (
    `You are reviving agent session ${session.id}, which the fleet watchdog detected as stalled ` +
    `(no progress for too long — likely a transient failure). Resume the work it was doing in this ` +
    `channel and carry it to completion.`
  );
}

export class WatchdogEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: WatchdogEngineDeps) {}

  /** Start the periodic loop. No-op if interval ≤ 0 or already started. */
  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tickAll(), intervalMs);
    this.timer.unref?.();
  }

  /** Stop the periodic loop (idempotent) — called on server shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One pass over the fleet's live sessions, grouped by workspace. */
  async tickAll(): Promise<void> {
    // #99: maintenance pauses the supervisor on the same Redis flag the HTTP write-gate reads.
    // Checked BEFORE any DB call so a maintenance window stops all watchdog work immediately.
    if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) {
      this.deps.logger.warn({}, "watchdog tickAll skipped: maintenance mode active");
      return;
    }
    const now = this.deps.now?.() ?? new Date();
    const live = await this.deps.listLiveSessions();
    const byWorkspace = new Map<string, LiveSession[]>();
    for (const session of live) {
      const list = byWorkspace.get(session.workspaceId) ?? [];
      list.push(session);
      byWorkspace.set(session.workspaceId, list);
    }
    for (const [workspaceId, sessions] of byWorkspace) {
      try {
        await this.tickWorkspace(workspaceId, sessions, now);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "watchdog tickAll: workspace tick failed");
      }
    }
  }

  /**
   * One pass over a single workspace's stale sessions. The config flag and the kill switch gate the
   * whole pass; then each session is decided + applied independently. Returns a result for tests.
   */
  async tickWorkspace(
    workspaceId: string,
    sessions: LiveSession[],
    now: Date,
  ): Promise<WorkspaceTickResult> {
    recordWatchdogTick();
    const log = this.deps.logger.child({ workspaceId, component: "watchdog" });

    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return { workspaceId, skipped: "disabled", actions: [] };

    if (await this.deps.killSwitch(workspaceId)) {
      log.warn({}, "watchdog tick skipped: kill switch engaged");
      recordWatchdogAction("noop:kill_switch");
      return { workspaceId, skipped: "kill_switch", actions: [] };
    }

    const budget = await this.deps.budgetExhausted(workspaceId, now);
    const thresholds = watchdogThresholds(caps);
    const actions: AppliedRevival[] = [];

    for (const session of sessions) {
      const record = await this.deps.revivals.getByCurrentSession(workspaceId, session.id);
      const inWindow =
        record && !windowExpired(now.getTime() - record.windowStartedAt.getTime(), caps.windowMs)
          ? record.revivals
          : 0;
      const msSinceLastRevival = record?.lastRevivalAt
        ? now.getTime() - record.lastRevivalAt.getTime()
        : Number.POSITIVE_INFINITY;
      const classification = classifyFailure(session.status);

      const decision = decideRevival({
        staleForMs: now.getTime() - session.progressAt.getTime(),
        revivalsInWindow: inWindow,
        msSinceLastRevival,
        retryable: classification.retryable,
        killSwitch: false, // already gated above
        budgetExhausted: budget,
        thresholds,
      });

      await this.apply(workspaceId, session, record, decision.action, decision.reason, caps, now, log);
      actions.push({ sessionId: session.id, action: decision.action, reason: decision.reason });
    }

    log.info({ count: actions.filter((a) => a.action !== "noop").length }, "watchdog tick complete");
    return { workspaceId, actions };
  }

  /** Apply a single decided action: the DB writes + the launch/escalation + the narrated message. */
  private async apply(
    workspaceId: string,
    session: LiveSession,
    existing: RevivalRecord | null,
    action: WatchdogAction,
    reason: string,
    caps: WatchdogCaps,
    now: Date,
    log: SessionLogger,
  ): Promise<void> {
    if (action === "noop" || action === "wait") {
      recordWatchdogAction(`${action}:${reason}`);
      return;
    }

    const errorClass = classifyFailure(session.status).class;
    const record =
      existing ??
      (await this.deps.revivals.createForRoot({
        workspaceId,
        rootSessionId: session.id,
        errorClass,
      }));

    // Finalize the dead/stalled row so it leaves the work-list (mirrors the #25 idle-reaper).
    await this.deps.finalizeDead(session.id, "failed");

    if (action === "revive") {
      const replacement = await this.deps.reviver.launch({
        workspaceId,
        channelId: session.channelId,
        agentMemberId: session.agentMemberId,
        createdByMemberId: session.createdByMemberId ?? session.agentMemberId,
        task: composeRevivalTask(session),
        harnessEnv: { AGENT_WATCHDOG_REVIVAL: "1" },
      });
      await this.deps.revivals.recordRevival({
        id: record.id,
        newSessionId: replacement.id,
        windowMs: caps.windowMs,
        errorClass,
        now,
      });
      recordWatchdogAction("revive");
      await this.post(
        session,
        `🐶 watchdog: session ${session.id} stalled — revived as ${replacement.id}.`,
        log,
      );
      return;
    }

    // escalate
    await this.deps.escalator.escalate({ workspaceId, session, record, reason });
    await this.deps.revivals.markEscalated(record.id);
    recordWatchdogAction("escalate");
    await this.post(
      session,
      `🚨 watchdog: session ${session.id} could not be revived (${reason}) — escalated to a human.`,
      log,
    );
  }

  /** Post into the session's channel; a delivery error never fails the tick. */
  private async post(session: LiveSession, body: string, log: SessionLogger): Promise<void> {
    if (!this.deps.poster) return;
    try {
      await this.deps.poster.post({
        workspaceId: session.workspaceId,
        channelId: session.channelId,
        agentMemberId: session.agentMemberId,
        body,
      });
    } catch (err) {
      log.error({ err, sessionId: session.id }, "watchdog channel post failed");
    }
  }
}
