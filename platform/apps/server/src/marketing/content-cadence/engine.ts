import type { SessionLogger } from "../../runtime/manager.js";
import {
  cadenceDayNumber,
  composeContentBrief,
  resolveContentCadenceFlags,
  selectCadenceQuery,
  type ContentCadenceConfigInput,
} from "./decide.js";

/**
 * ContentCadenceEngine (#416, with #415) — the scheduled tick that gives the fleet a NEW marketing
 * objective so it ships a steady stream of on-site content instead of re-auditing the homepage. Mirrors
 * the #173 founder-briefings engine: an opt-in periodic timer (default OFF, started in `index.ts` only when
 * `CONTENT_CADENCE_INTERVAL_MS > 0`) whose `tickAll()` lists workspaces and briefs each in-scope one.
 *
 * Gating mirrors the platform: maintenance (#99) pauses the whole pass first; the per-workspace flags are
 * default-OFF + owner-first ({@link resolveContentCadenceFlags}); and a once-per-day watermark makes a
 * repeat tick within the same day a no-op (so a 1-hour interval still launches ONE content brief/day,
 * rotating through the query calendar). The launch reuses the audited {@link MarketingBriefService} path
 * (#59/#96/#71 gates) — the engine introduces NO new launch or publish authority; the produced draft still
 * flows through the #13 approval queue before the `site_pr` adapter publishes anything.
 */
export interface ContentCadenceEngineDeps {
  /** The loaded `contentCadence` config block (per-deployment). Read each tick so a live edit takes effect. */
  config: () => ContentCadenceConfigInput | undefined;
  /** The work-list: every workspace (flags filter to the in-scope owner workspace). */
  listWorkspaceIds: () => Promise<string[]>;
  /** Resolve the workspace owner's member id — the brief is posted AS the owner human. Undefined ⇒ skip. */
  resolveOwnerMemberId: (workspaceId: string) => Promise<string | undefined>;
  /**
   * Launch the brief through the audited @mention path ({@link MarketingBriefService.brief}). `systemAuthorized`
   * is set because this is a server-driven launch with no human in the channel-RBAC (the #417 pattern); the
   * venture/admission gate still runs.
   */
  brief: (
    identity: { workspaceId: string; memberId: string },
    input: { lead: string; goal: string; systemAuthorized: true },
  ) => Promise<{ ok: boolean; code?: number; error?: string }>;
  /** Optional maintenance-pause check (#99). True ⇒ skip the whole pass. */
  maintenancePaused?: () => Promise<boolean>;
  logger: SessionLogger;
  /** Clock seam — defaults to `new Date()`; tests inject a fixed clock. */
  now?: () => Date;
}

export interface ContentCadenceTickResult {
  workspaceId: string;
  /** The query briefed this tick, or null when the tick was a no-op. */
  briefed: string | null;
  /** Why the tick briefed or skipped (for logs/tests). */
  reason:
    | "briefed"
    | "disabled"
    | "already-briefed-today"
    | "no-owner"
    | "no-query"
    | "launch-failed";
}

export class ContentCadenceEngine {
  private timer?: NodeJS.Timeout;
  /** workspaceId → the day number we last CLAIMED a brief for (set before launch so a failure can't re-spam). */
  private readonly briefedDay = new Map<string, number>();

  constructor(private readonly deps: ContentCadenceEngineDeps) {}

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

  /** One pass over every workspace. Maintenance pauses the whole pass before any work. */
  async tickAll(): Promise<void> {
    if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) {
      this.deps.logger.warn({}, "content-cadence tickAll skipped: maintenance mode active");
      return;
    }
    const now = this.deps.now?.() ?? new Date();
    const workspaceIds = await this.deps.listWorkspaceIds();
    for (const workspaceId of workspaceIds) {
      try {
        await this.tickWorkspace(workspaceId, now);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "content-cadence: workspace tick failed");
      }
    }
  }

  /**
   * Brief one workspace's next content objective. A no-op when the cadence is disabled/out-of-scope, when
   * there's no owner to post as, or when a brief was already CLAIMED today (the watermark). The day is
   * claimed BEFORE the launch, so even a thrown/failed launch can never re-spam launches the same day.
   * Exposed so tests drive a single tick with an injected clock and no timer.
   */
  async tickWorkspace(workspaceId: string, now: Date): Promise<ContentCadenceTickResult> {
    const flags = resolveContentCadenceFlags(this.deps.config(), workspaceId);
    if (!flags.enabled) return { workspaceId, briefed: null, reason: "disabled" };

    const day = cadenceDayNumber(now);
    if (this.briefedDay.get(workspaceId) === day) {
      return { workspaceId, briefed: null, reason: "already-briefed-today" };
    }

    const query = selectCadenceQuery(flags.queries, day);
    if (query === null) return { workspaceId, briefed: null, reason: "no-query" };

    const ownerMemberId = await this.deps.resolveOwnerMemberId(workspaceId);
    if (!ownerMemberId) {
      this.deps.logger.warn({ workspaceId }, "content-cadence: no owner member to brief as; skipping");
      return { workspaceId, briefed: null, reason: "no-owner" };
    }

    // Claim the day up-front so a launch failure can never cause a second launch attempt today (#200 §4 —
    // a brief spends compute; never double-spend on a retry loop). A transient failure simply waits a day.
    this.briefedDay.set(workspaceId, day);

    const goal = composeContentBrief(query);
    const result = await this.deps.brief(
      { workspaceId, memberId: ownerMemberId },
      { lead: flags.lead, goal, systemAuthorized: true },
    );
    if (!result.ok) {
      this.deps.logger.warn(
        { workspaceId, query, code: result.code, error: result.error },
        "content-cadence: brief launch failed",
      );
      return { workspaceId, briefed: null, reason: "launch-failed" };
    }
    this.deps.logger.info({ workspaceId, query, lead: flags.lead }, "content-cadence: briefed next content objective");
    return { workspaceId, briefed: query, reason: "briefed" };
  }
}
