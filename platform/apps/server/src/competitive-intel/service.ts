/**
 * The competitive-intelligence service (issue #619) — the agent step that produces the weekly competitor
 * digest. For each tracked competitor it observes a fresh snapshot, diffs it against the last stored snapshot
 * with the pure {@link diffSnapshots} core, persists the new snapshot, then assembles one
 * {@link CompetitorDigest} highlighting the material changes with their sources.
 *
 * Default-OFF + fallback contract (mirrors the trends/social provider seams):
 *   - module DISABLED ⇒ every competitor is served by the deterministic offline fake — NO external call —
 *     and the digest is tagged `servedBy: "fake-disabled"`.
 *   - module ENABLED ⇒ the injected live source is used; if it throws for a competitor we fall back to the
 *     fake for that competitor and tag the digest `servedBy: "fake-fallback"`. A clean live run is `"live"`.
 *
 * Like the #670/#587 modules it does no IO except through the injected store / source / `now` seams, touches
 * no migration / schema barrel / app-wiring registry, and the only external reach is gated behind `enabled`.
 */

import { resolveCompetitiveIntelCaps, type CompetitiveIntelCaps } from "./caps.js";
import { buildDigest, diffSnapshots } from "./detect.js";
import { FakeCompetitorIntelSource, type CompetitorIntelSource } from "./provider.js";
import type { CompetitiveIntelStore, DigestRecord } from "./store.js";
import type { CompetitorDigest, CompetitorRef, MaterialChange } from "./types.js";

export interface CompetitiveIntelDeps {
  store: CompetitiveIntelStore;
  /** The live competitor source. Defaults to the offline {@link FakeCompetitorIntelSource}. */
  source?: CompetitorIntelSource;
  /** Resolved caps. Defaults to the env-resolved caps. */
  caps?: CompetitiveIntelCaps;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => Date;
}

/** The input for {@link CompetitiveIntelService.generateDigest}. */
export interface GenerateDigestInput {
  workspaceId: string;
  /** The competitors to track this run. May be empty (⇒ an empty digest). */
  competitors: CompetitorRef[];
  /** The member/agent on whose behalf the digest runs (recorded as the requester). */
  requesterMemberId?: string | null;
}

/** The result of generating a digest: the digest plus the persisted record it produced. */
export interface GenerateDigestResult {
  digest: CompetitorDigest;
  record: DigestRecord;
}

export class CompetitiveIntelService {
  private readonly store: CompetitiveIntelStore;
  private readonly source: CompetitorIntelSource;
  private readonly fake: FakeCompetitorIntelSource;
  private readonly caps: CompetitiveIntelCaps;
  private readonly now: () => Date;

  constructor(deps: CompetitiveIntelDeps) {
    this.store = deps.store;
    this.fake = new FakeCompetitorIntelSource();
    this.source = deps.source ?? this.fake;
    this.caps = deps.caps ?? resolveCompetitiveIntelCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** The resolved caps (read-only) — handy for a UI hint or dry-run. */
  get policy(): CompetitiveIntelCaps {
    return this.caps;
  }

  /**
   * Generate (and persist) the competitor digest: observe each competitor, diff against the prior snapshot,
   * save the new snapshot, and assemble the digest of material changes. Never reaches the network when the
   * module is disabled; falls back to the offline fake per-competitor if an enabled live source throws.
   */
  async generateDigest(input: GenerateDigestInput): Promise<GenerateDigestResult> {
    const now = this.now();
    const allChanges: MaterialChange[] = [];
    let usedFallback = false;

    for (const competitor of input.competitors) {
      const observed = await this.observe(competitor);
      if (observed.fellBack) usedFallback = true;

      const prev = await this.store.latestSnapshot(input.workspaceId, competitor.id);
      const changes = diffSnapshots(prev?.snapshot ?? null, observed.snapshot, this.caps);
      allChanges.push(...changes);

      await this.store.saveSnapshot({
        workspaceId: input.workspaceId,
        competitorId: competitor.id,
        snapshot: observed.snapshot,
        capturedAt: now,
      });
    }

    const servedBy = this.resolveServedBy(usedFallback);
    const digest = buildDigest({
      workspaceId: input.workspaceId,
      competitorIds: input.competitors.map((c) => c.id),
      changes: allChanges,
      generatedAt: now.toISOString(),
      servedBy,
      caps: this.caps,
    });

    const record = await this.store.saveDigest({
      workspaceId: input.workspaceId,
      digest,
      requestedByMemberId: input.requesterMemberId ?? null,
      generatedAt: now,
    });

    return { digest, record };
  }

  /** Load one persisted digest within a workspace. */
  async getDigest(workspaceId: string, id: string): Promise<DigestRecord | null> {
    return this.store.getDigest(workspaceId, id);
  }

  /** A workspace's digests, newest first, optionally limited. */
  async listDigests(workspaceId: string, limit?: number): Promise<DigestRecord[]> {
    return this.store.listDigests(workspaceId, limit);
  }

  /** Observe one competitor honoring the default-OFF + fallback contract. */
  private async observe(
    competitor: CompetitorRef,
  ): Promise<{ snapshot: Awaited<ReturnType<CompetitorIntelSource["fetchSnapshot"]>>; fellBack: boolean }> {
    if (!this.caps.enabled) {
      // Disabled ⇒ never touch the (possibly live) injected source. Offline fake only.
      return { snapshot: await this.fake.fetchSnapshot(competitor), fellBack: false };
    }
    try {
      return { snapshot: await this.source.fetchSnapshot(competitor), fellBack: false };
    } catch {
      return { snapshot: await this.fake.fetchSnapshot(competitor), fellBack: true };
    }
  }

  private resolveServedBy(usedFallback: boolean): CompetitorDigest["servedBy"] {
    if (!this.caps.enabled) return "fake-disabled";
    if (usedFallback) return "fake-fallback";
    // Enabled but the injected source is itself the offline fake ⇒ still honestly "fake-disabled".
    return this.source.live ? "live" : "fake-disabled";
  }
}
