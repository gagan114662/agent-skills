/**
 * Daily agent standup digest — the **service** (issue #589).
 *
 * Orchestrates the three seams into the one capability the issue asks for: *a single daily digest that
 * summarizes all agent activity, grouped by agent, with working links — so nobody has to read raw logs.*
 *
 *   data-source  →  pure synthesis  →  store
 *   (what happened)  (what it means)   (so it can be read back)
 *
 * `generateDigest` is the manual path; `runScheduledDigest` is the daily-tick seam a scheduler (#559) would
 * call — it is idempotent per day (re-running the same day returns the already-stored digest rather than
 * regenerating). Both are gated by the env master switch (default OFF), so nothing runs until the feature is
 * deliberately enabled.
 *
 * The clock is injected (`now`), and the data + persistence are seams, so the service is fully unit-testable
 * with no DB, no network, and no wall-clock dependency.
 */

import { resolveStandupDigestCaps, type StandupDigestCaps } from "./caps.js";
import type { DailyActivitySource } from "./source.js";
import { digestId, type StandupDigestRecord, type StandupDigestStore } from "./store.js";
import { synthesizeDailyDigest } from "./synthesize.js";
import type { DigestPeriod } from "./types.js";

/** A standup-digest-domain rejection (e.g. the feature is disabled). Routes/callers map this to 4xx. */
export class StandupDigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StandupDigestError";
  }
}

export interface StandupDigestSettings {
  enabled: boolean;
  maxItemsPerSection: number;
}

export interface StandupDigestServiceDeps {
  store: StandupDigestStore;
  dataSource: DailyActivitySource;
  /** Caps override (tests pass an enabled value); defaults to the env-resolved caps. */
  caps?: StandupDigestCaps;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

/** Zero-pad to 2 digits. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Format a Date as a UTC `YYYY-MM-DD` string (no timezone drift). */
export function isoDay(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** The UTC calendar day containing `now`. Pure given its argument — the service supplies the clock. */
export function dayContaining(now: Date): DigestPeriod {
  return { day: isoDay(now) };
}

export class StandupDigestService {
  private readonly store: StandupDigestStore;
  private readonly dataSource: DailyActivitySource;
  private readonly caps: StandupDigestCaps;
  private readonly now: () => Date;

  constructor(deps: StandupDigestServiceDeps) {
    this.store = deps.store;
    this.dataSource = deps.dataSource;
    this.caps = deps.caps ?? resolveStandupDigestCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** Whether the feature is enabled for this deployment (gates generation). */
  get enabled(): boolean {
    return this.caps.enabled;
  }

  settings(): StandupDigestSettings {
    return { enabled: this.caps.enabled, maxItemsPerSection: this.caps.maxItemsPerSection };
  }

  /**
   * Generate (and persist) the digest for a specific day. Fetches the day's activity via the source, runs the
   * pure synthesis, and upserts the result keyed by workspace-day. Throws {@link StandupDigestError} if the
   * feature is disabled.
   */
  async generateDigest(workspaceId: string, period: DigestPeriod): Promise<StandupDigestRecord> {
    if (!this.caps.enabled) throw new StandupDigestError("standup digest is disabled");
    const data = await this.dataSource.fetch(workspaceId, period);
    const digest = synthesizeDailyDigest(data, this.caps.maxItemsPerSection);
    const record: StandupDigestRecord = {
      id: digestId(workspaceId, period.day),
      workspaceId,
      period,
      digest,
      generatedAt: this.now(),
    };
    return this.store.save(record);
  }

  /**
   * The daily scheduler tick (#559 seam). Generates the digest for the day containing `now` — but only once:
   * if a digest for that day already exists it is returned unchanged (idempotent). Returns null when the
   * feature is disabled, so a scheduler can call it unconditionally.
   */
  async runScheduledDigest(workspaceId: string): Promise<StandupDigestRecord | null> {
    if (!this.caps.enabled) return null;
    const period = dayContaining(this.now());
    const existing = await this.store.get(workspaceId, digestId(workspaceId, period.day));
    if (existing) return existing;
    return this.generateDigest(workspaceId, period);
  }

  /** Load one digest by id (workspace-scoped); null if absent. */
  getDigest(workspaceId: string, id: string): Promise<StandupDigestRecord | null> {
    return this.store.get(workspaceId, id);
  }

  /** A workspace's digests, newest day first. */
  listDigests(workspaceId: string): Promise<StandupDigestRecord[]> {
    return this.store.list(workspaceId);
  }

  /** The most recent digest for a workspace, or null if none yet. */
  latestDigest(workspaceId: string): Promise<StandupDigestRecord | null> {
    return this.store.latest(workspaceId);
  }
}
