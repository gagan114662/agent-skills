import { buildMissionControl, type MissionControl, type MissionSessionInput } from "./build.js";

/**
 * Mission-control read service (#147, ADR-0147 §6). Reads the workspace's live sessions + the tenant's
 * #71 compute rate and hands them to the pure {@link buildMissionControl}. Read-only — the steer/stop
 * controls are thin route glue over the already-audited #53 steer + #25 cancel seams (tenant-scoped in
 * the route by resolving the session's workspace), so they need no service abstraction here.
 */
export interface MissionControlDeps {
  /** The workspace's live (non-terminal) sessions. */
  listLiveSessions: (workspaceId: string) => Promise<MissionSessionInput[]>;
  /** The tenant's #71 compute rate (cents/minute) for the spend estimate. */
  rate: (workspaceId: string) => number;
  now?: () => Date;
}

export class MissionControlService {
  constructor(private readonly deps: MissionControlDeps) {}

  private clock(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The live fleet for a workspace (status / elapsed / estimated spend + roll-up). */
  async get(workspaceId: string): Promise<MissionControl> {
    const sessions = await this.deps.listLiveSessions(workspaceId);
    return buildMissionControl({ sessions, rateCentsPerMinute: this.deps.rate(workspaceId), now: this.clock() });
  }
}
