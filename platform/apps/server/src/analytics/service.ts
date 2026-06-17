/**
 * Analytics auto-install + read — the service (issue #270).
 *
 * The orchestrator Lens's analytics layer runs through. It binds the pure decision brain ({@link
 * decideAnalyticsInstall} / {@link resolveAnalyticsFlags}) to the injected seams (site context, read
 * provider, install store) so it is unit-testable with fakes and no DB.
 *
 * Three jobs:
 *  1. {@link ensureInstalled} — idempotently put the tag on the workspace's site (record the install). This
 *     is the "no tag or code work by the user" half of #270: when the layer is on, the install happens
 *     automatically; it only writes when the install is absent or its snippet fingerprint changed.
 *  2. {@link read} — return the site's externally-grounded metrics, or `null` when not connected.
 *  3. {@link tileReading} — fold (1)+(2) into the founder-console proof tile for the analytics department,
 *     returning `null` when the layer is off OR has no real provider reading so the console falls back to
 *     today's internal #102 funnel reading (strictly additive — the scorecard never loses a number).
 *
 * Default OFF: with the layer off for a workspace, every method short-circuits — no provider call, no DB
 * write — so an un-configured deployment behaves byte-for-byte as before.
 */

import type { ProofMetricReading } from "../founder-console/proof-scorecard.js";
import {
  decideAnalyticsInstall,
  isAnalyticsTagInstalled,
  type AnalyticsFlags,
  type AnalyticsSiteContext,
} from "./decide.js";
import { analyticsSnippetFingerprint, analyticsTagSnippet } from "./tag.js";
import type { AnalyticsInstall, AnalyticsInstallStore, AnalyticsProvider, AnalyticsReading } from "./types.js";

/** The trailing window the analytics tile reports over. */
export const ANALYTICS_WINDOW_DAYS = 7;

export interface AnalyticsServiceDeps {
  /** Resolve the per-workspace flags (default OFF, owner-first) — see {@link resolveAnalyticsFlags}. */
  flagsFor(workspaceId: string): AnalyticsFlags;
  /** Resolve the structural site facts that decide the install method (hosted / connected external). */
  siteContextFor(workspaceId: string): Promise<AnalyticsSiteContext>;
  /** The read provider selected by config (`dryrun` default). */
  provider: AnalyticsProvider;
  /** The install record store. */
  installs: AnalyticsInstallStore;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface AnalyticsSummary {
  enabled: boolean;
  install: AnalyticsInstall | null;
  reading: AnalyticsReading | null;
}

export class AnalyticsService {
  private readonly now: () => number;
  constructor(private readonly deps: AnalyticsServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Idempotently install the analytics tag for a workspace. Returns the install record, or `null` when the
   * layer is off (no write). Writes only when the install is absent or its snippet fingerprint changed, so
   * it is safe to call on every console render.
   */
  async ensureInstalled(workspaceId: string): Promise<AnalyticsInstall | null> {
    const flags = this.deps.flagsFor(workspaceId);
    if (!flags.enabled) return null;

    const site = await this.deps.siteContextFor(workspaceId);
    const method = decideAnalyticsInstall(site);
    const snippet = analyticsTagSnippet(flags.provider, flags.measurementId);
    const fingerprint = analyticsSnippetFingerprint(method, snippet);

    const existing = await this.deps.installs.get(workspaceId);
    if (existing && existing.snippetFingerprint === fingerprint) return existing;

    const now = this.now();
    const install: AnalyticsInstall = {
      workspaceId,
      method,
      provider: flags.provider,
      measurementId: flags.measurementId,
      snippetFingerprint: fingerprint,
      installedAtMs: existing?.installedAtMs ?? now,
      updatedAtMs: now,
    };
    await this.deps.installs.upsert(install);
    return install;
  }

  /** Read the site's externally-grounded metrics, or `null` when the layer is off / not connected. */
  async read(workspaceId: string): Promise<AnalyticsReading | null> {
    const flags = this.deps.flagsFor(workspaceId);
    if (!flags.enabled) return null;
    await this.ensureInstalled(workspaceId);
    return this.deps.provider.readMetrics(workspaceId, ANALYTICS_WINDOW_DAYS);
  }

  /** Install status + the latest reading for the `/me/analytics` route. */
  async summary(workspaceId: string): Promise<AnalyticsSummary> {
    const flags = this.deps.flagsFor(workspaceId);
    if (!flags.enabled) return { enabled: false, install: null, reading: null };
    const install = await this.ensureInstalled(workspaceId);
    const reading = await this.deps.provider.readMetrics(workspaceId, ANALYTICS_WINDOW_DAYS);
    return { enabled: true, install, reading };
  }

  /**
   * The analytics department proof tile, or `null` to fall back to the console's internal #102 funnel
   * reading. Returns a `connected:true` reading only when a real provider returned numbers; when the layer
   * is on but the tag has no reading yet, returns `null` so the funnel reading still shows (no regression).
   */
  async tileReading(workspaceId: string): Promise<ProofMetricReading | null> {
    const reading = await this.read(workspaceId);
    if (!reading) return null;
    return {
      department: "analytics",
      connected: true,
      current: reading.conversions,
      unit: "count",
      metricLabel: "Conversions (last 7 days)",
      source: `Site analytics — auto-installed (#270, ${reading.source})`,
      note: `${reading.sessions} sessions · ${reading.signups} signups · ${reading.conversions} conversions`,
    };
  }

  /** Whether the current install actually put a tag on the site (so Lens can begin to report). */
  static tagIsLive(install: AnalyticsInstall | null): boolean {
    return install !== null && isAnalyticsTagInstalled(install.method);
  }
}
