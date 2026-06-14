import { buildMissionControl, type MissionControl, type MissionSessionInput } from "./build.js";
import {
  diagnose,
  type MissionDiagnostic,
  type RecentFailureView,
  type RecentSessionInput,
} from "./diagnose.js";

/**
 * Mission-control read service (#147, ADR-0147 §6). Reads the workspace's live sessions + the tenant's
 * #71 compute rate and hands them to the pure {@link buildMissionControl}. Read-only — the steer/stop
 * controls are thin route glue over the already-audited #53 steer + #25 cancel seams (tenant-scoped in
 * the route by resolving the session's workspace), so they need no service abstraction here.
 *
 * #230: it also computes the "why is nothing running?" diagnostic (pure {@link diagnose}) over the
 * workspace's recent sessions + activation state, so the console can replace the indefinite "clocking
 * in… hang tight" with a filling board OR an explicit, actionable reason — never silence.
 */
export interface MissionControlDeps {
  /** The workspace's live (non-terminal) sessions. */
  listLiveSessions: (workspaceId: string) => Promise<MissionSessionInput[]>;
  /** The tenant's #71 compute rate (cents/minute) for the spend estimate. */
  rate: (workspaceId: string) => number;
  /**
   * The workspace's recent sessions (incl. terminal rows) for the #230 diagnostic — so a spawn-and-die
   * fleet (zero live rows) is still visible with its exit reason. Optional: absent ⇒ no recent failures.
   */
  recentSessions?: (workspaceId: string) => Promise<RecentSessionInput[]>;
  /** Whether the workspace has a founding venture (activated). Optional: absent ⇒ treated as false. */
  hasVenture?: (workspaceId: string) => Promise<boolean>;
  /** Whether that venture has an epic / open tasks to pick up. Optional: absent ⇒ treated as false. */
  hasOpenWork?: (workspaceId: string) => Promise<boolean>;
  now?: () => Date;
}

/** The live fleet plus the #230 diagnostic + classified recent failures. */
export interface MissionControlView extends MissionControl {
  diagnostic: MissionDiagnostic;
  recentFailures: RecentFailureView[];
}

export class MissionControlService {
  constructor(private readonly deps: MissionControlDeps) {}

  private clock(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The live fleet for a workspace (status / elapsed / estimated spend + roll-up) + the diagnostic. */
  async get(workspaceId: string): Promise<MissionControlView> {
    const now = this.clock();
    const [sessions, recent, hasVenture, hasOpenWork] = await Promise.all([
      this.deps.listLiveSessions(workspaceId),
      this.deps.recentSessions?.(workspaceId) ?? Promise.resolve([] as RecentSessionInput[]),
      this.deps.hasVenture?.(workspaceId) ?? Promise.resolve(false),
      this.deps.hasOpenWork?.(workspaceId) ?? Promise.resolve(false),
    ]);
    const mc = buildMissionControl({ sessions, rateCentsPerMinute: this.deps.rate(workspaceId), now });
    const { diagnostic, recentFailures } = diagnose({
      liveCount: mc.count,
      recent,
      hasVenture,
      hasOpenWork,
      nowMs: now.getTime(),
    });
    return { ...mc, diagnostic, recentFailures };
  }
}
