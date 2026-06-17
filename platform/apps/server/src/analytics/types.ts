/**
 * Analytics auto-install + read — the seam types (issue #270).
 *
 * The interfaces Lens's analytics layer reads/writes through. Keeping them in one tiny file lets the pure
 * service, the providers, and the db repository depend on the contracts without importing each other.
 */

import type { AnalyticsInstallMethod } from "./decide.js";

/** A durable record that ipop put the analytics tag on a workspace's site — the proof of "no user work". */
export interface AnalyticsInstall {
  workspaceId: string;
  /** How the tag was installed (hosted inject / connector / pending). */
  method: AnalyticsInstallMethod;
  /** The read provider the tag feeds (`dryrun` | `ga4` | `plausible`). */
  provider: string;
  /** The GA4 measurement id / Plausible domain the tag carries (empty until configured). */
  measurementId: string;
  /** Content fingerprint of the installed snippet — changes when provider/id change (idempotent re-install). */
  snippetFingerprint: string;
  installedAtMs: number;
  updatedAtMs: number;
}

/**
 * One externally-grounded reading of a site's analytics. Every field is a real count a connected provider
 * returned for the window — NEVER fabricated. A provider with no connection returns `null` instead of a
 * zero-filled reading (premortem #200 §2), so the console can say "installed, awaiting first reading"
 * rather than overclaim traffic that was never measured.
 */
export interface AnalyticsReading {
  /** Sessions / visits in the window. */
  sessions: number;
  /** Sign-ups (the GA4/Plausible conversion event mapped to "signup"). */
  signups: number;
  /** Goal conversions (trials, purchases) in the window. */
  conversions: number;
  /** The trailing window the counts cover. */
  windowDays: number;
  /** The provider that returned the numbers (`ga4` | `plausible`) — the proof they came from outside. */
  source: string;
}

/** The read seam: a vendor that returns a site's real metrics, or `null` when not connected. */
export interface AnalyticsProvider {
  /** Stable id (`dryrun` | `ga4` | `plausible`). */
  readonly id: string;
  /** Read the window's metrics for a workspace, or `null` when no live connection exists. */
  readMetrics(workspaceId: string, windowDays: number): Promise<AnalyticsReading | null>;
}

/** The persistence seam for install records (one row per workspace). */
export interface AnalyticsInstallStore {
  get(workspaceId: string): Promise<AnalyticsInstall | null>;
  /** Idempotent upsert — one install per workspace, keyed by `workspace_id`. */
  upsert(install: AnalyticsInstall): Promise<void>;
}
