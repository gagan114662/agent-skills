/**
 * Cross-industry award-transfer — service + owner-first gate (#1547, ADR-1547).
 *
 * Ties the pure pieces together: {@link buildTerritoryBriefs} (transfer), {@link renderTerritoryBriefsBlock}
 * (the DATA block the creative/Quill drafting step consumes), and {@link screenDraftAgainstCases} (Lens's
 * derivative screen). Optionally holds a {@link AwardReferenceMiner} for live enrichment, but the default is
 * the in-code archive — no network is needed to return real, named territory briefs.
 *
 * GATE (default-OFF, owner-workspace-first): {@link shouldRunAwardTransfer} mirrors the #363 site-reader
 * posture — active only when `marketing.awardTransfer` is set AND this is the designated owner workspace.
 * Fail-closed: the flag off, or an unnamed owner, runs nothing (named-nobody = nobody). The service performs
 * no send/spend and grants no tools — producing a territory brief can never widen an agent's scope (#13).
 */

import { AWARD_CASES, type AwardCase } from "./corpus.js";
import { screenDraftAgainstCases, type DerivativeScreen } from "./derivative.js";
import { DryRunReferenceMiner, type AwardReferenceMiner, type MinedPage } from "./provider.js";
import {
  buildTerritoryBriefs,
  renderTerritoryBriefsBlock,
  type BuildTerritoryOptions,
  type ClientArtifact,
  type TerritoryBrief,
} from "./transfer.js";

/**
 * The default-OFF, owner-workspace-first gate (#1547). Pure ⇒ unit-testable; the IO seam consults it before
 * building the territory-briefs block for a briefed task. An unconfigured deployment produces nothing.
 */
export function shouldRunAwardTransfer(
  marketing: { awardTransfer?: boolean; ownerWorkspaceId?: string },
  workspaceId: string,
): boolean {
  if (!marketing.awardTransfer) return false;
  return marketing.ownerWorkspaceId !== undefined && marketing.ownerWorkspaceId === workspaceId;
}

export interface AwardTransferService {
  /** The archive this service draws from (the in-code {@link AWARD_CASES} by default). */
  readonly cases: readonly AwardCase[];
  /** Retrieve territory briefs for a client artifact (3 by default), each anchored in a distant case. */
  territoryBriefsForClient(client: ClientArtifact, opts?: BuildTerritoryOptions): TerritoryBrief[];
  /** Render territory briefs into the DATA block the creative/Quill drafting step consumes (or null). */
  territoryBriefsBlock(client: ClientArtifact, opts?: BuildTerritoryOptions): string | null;
  /** Lens's screen: is a draft derivative of the source cases behind these territory briefs? */
  screenDraft(draft: string, briefs: readonly TerritoryBrief[]): DerivativeScreen;
  /** Optional live enrichment: mine public case write-ups behind the SSRF-safe guard (DryRun by default). */
  mineReferences(urls: readonly string[], onLog?: (line: string) => void): Promise<MinedPage[]>;
}

export interface AwardTransferServiceDeps {
  /** The archive to draw from (default {@link AWARD_CASES}); injectable for tests. */
  cases?: readonly AwardCase[];
  /** The live miner (default {@link DryRunReferenceMiner} — reads nothing). */
  miner?: AwardReferenceMiner;
}

/**
 * Build the award-transfer service. Defaults to the in-code archive + the non-networked miner, so an
 * unconfigured caller is inert and fully offline. The archive is injectable so tests can drive selection.
 */
export function createAwardTransferService(deps: AwardTransferServiceDeps = {}): AwardTransferService {
  const cases = deps.cases ?? AWARD_CASES;
  const miner = deps.miner ?? new DryRunReferenceMiner();

  const withArchive = (opts?: BuildTerritoryOptions): BuildTerritoryOptions => ({
    ...opts,
    cases: opts?.cases ?? cases,
  });

  return {
    cases,
    territoryBriefsForClient(client, opts) {
      return buildTerritoryBriefs(client, withArchive(opts));
    },
    territoryBriefsBlock(client, opts) {
      return renderTerritoryBriefsBlock(buildTerritoryBriefs(client, withArchive(opts)));
    },
    screenDraft(draft, briefs) {
      // Resolve each brief's cited source case back to its full record (with execution motifs) to screen.
      const byId = new Map(cases.map((c) => [c.id, c] as const));
      const sourceCases = briefs
        .map((b) => byId.get(b.sourceCase.id))
        .filter((c): c is AwardCase => c !== undefined);
      return screenDraftAgainstCases(draft, sourceCases);
    },
    async mineReferences(urls, onLog) {
      return miner.mine(urls, onLog);
    },
  };
}
