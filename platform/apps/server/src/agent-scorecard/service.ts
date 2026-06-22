/**
 * The per-agent scorecard service (issue #593) — the step the fleet calls to answer "which agent drove paying
 * customers, and through which channel?". It ties three seams together over the persisted {@link ScorecardStore}:
 *
 *   1. SYNC — pull the current conversion feed from the injected {@link ConversionSource}, append new events
 *      (idempotently — re-ingesting is safe), and refresh the activity snapshot. This is the "updated as
 *      conversions land" step.
 *   2. READ — recompute the ranked, conversion-tied scorecard from everything stored, via the pure core
 *      {@link buildScorecard}. The ranking key + pipeline blend weight come from the resolved caps.
 *
 * Safe by default: the scorecard is OFF unless explicitly enabled for the workspace, and the default source is the
 * deterministic {@link FakeConversionSource}, so no external system is queried until both are flipped. Like the
 * #741 avatar-studio service it does no IO except through the injected store, source, and caps seams, touches no
 * migration / schema barrel / app-wiring registry, and is fail-closed on enablement.
 */

import {
  isScorecardEnabledForWorkspace,
  resolveScorecardCaps,
  type ScorecardCaps,
} from "./caps.js";
import { buildScorecard, type RankBy } from "./score.js";
import { FakeConversionSource, type ConversionSource } from "./source.js";
import type { ScorecardStore } from "./store.js";
import type { Scorecard } from "./types.js";

export interface ScorecardServiceDeps {
  store: ScorecardStore;
  /** The conversion source. Defaults to the deterministic, offline {@link FakeConversionSource}. */
  source?: ConversionSource;
  /** Resolved caps. Defaults to the env-resolved caps. */
  caps?: ScorecardCaps;
}

/** The outcome of a {@link ScorecardService.sync}. */
export interface SyncResult {
  /** New conversion events appended this sync (already-seen events are ignored). */
  eventsIngested: number;
  /** Activity rows written this sync. */
  activitiesIngested: number;
  /** The source the feed came from (`"fake"` or a live source name). */
  source: string;
}

/** Options for reading a scorecard — override the ranking key without changing config. */
export interface ScorecardReadOptions {
  rankBy?: RankBy;
}

export class ScorecardService {
  private readonly store: ScorecardStore;
  private readonly source: ConversionSource;
  private readonly caps: ScorecardCaps;

  constructor(deps: ScorecardServiceDeps) {
    this.store = deps.store;
    this.source = deps.source ?? new FakeConversionSource();
    this.caps = deps.caps ?? resolveScorecardCaps();
  }

  /** The resolved caps (read-only) — handy for a UI hint or dry-run. */
  get policy(): ScorecardCaps {
    return this.caps;
  }

  /** Whether the scorecard is offered for a workspace (pure, fail-closed). */
  isEnabledFor(workspaceId: string): boolean {
    return isScorecardEnabledForWorkspace(this.caps, workspaceId);
  }

  /**
   * Pull the current conversion feed from the source and fold it into the store: append new events, refresh the
   * activity snapshot. Refuses when the scorecard is disabled for the workspace (fail-closed, owner-first rollout).
   */
  async sync(workspaceId: string): Promise<SyncResult> {
    this.assertEnabled(workspaceId);
    const feed = await this.source.fetch(workspaceId);
    const eventsIngested = await this.store.appendEvents(workspaceId, feed.events);
    const activitiesIngested = await this.store.replaceActivity(workspaceId, feed.activities);
    return { eventsIngested, activitiesIngested, source: this.source.name };
  }

  /**
   * Recompute the ranked scorecard from everything stored for the workspace. Refuses when disabled. The ranking
   * key defaults to the caps' policy (`influence`) but can be overridden per call (e.g. rank by `revenue` only) —
   * which directly serves the acceptance criterion "rank agents by revenue/pipeline influenced".
   */
  async getScorecard(workspaceId: string, options: ScorecardReadOptions = {}): Promise<Scorecard> {
    this.assertEnabled(workspaceId);
    const [events, activities] = await Promise.all([
      this.store.listEvents(workspaceId),
      this.store.listActivity(workspaceId),
    ]);
    return buildScorecard(
      { events, activities },
      { pipelineWeight: this.caps.pipelineWeight, rankBy: options.rankBy ?? "influence" },
    );
  }

  private assertEnabled(workspaceId: string): void {
    if (!this.isEnabledFor(workspaceId)) {
      throw new ScorecardError("agent scorecard is disabled for this workspace");
    }
  }
}

/** A scorecard operation rejected for a stated reason (mapped to 4xx at any route layer). */
export class ScorecardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScorecardError";
  }
}
