/**
 * Persistence seam for the central campaign brief (#588). The narrow interface the service consumes — load
 * and save a single per-workspace brief record carrying a monotonic {@link BriefRecord.revision} plus the
 * last-editor audit. The production binding is the self-managed Postgres store in `campaign-brief/default.ts`;
 * unit tests inject {@link InMemoryBriefStore}, so the service is tested with no database (the #17
 * pure-decision + injected-seam pattern).
 *
 * Everything is workspace-scoped (the `workspaceId` is the record key / the first argument of every method)
 * so a caller can only ever read or mutate its own tenant's brief — the #3 IDOR boundary.
 */

import { EMPTY_BRIEF, type CampaignBrief } from "./brief.js";

/**
 * The persisted brief record: the brief itself plus the revision counter and last-editor audit. `revision`
 * starts at 0 for an un-set brief and increments by 1 on every save, so a planner can tell WHICH version of
 * the brief a task was built against (the proof an edit propagated).
 */
export interface BriefRecord {
  workspaceId: string;
  brief: CampaignBrief;
  /** Monotonic version. 0 = never edited (the {@link EMPTY_BRIEF}); each save increments it. */
  revision: number;
  /** Member id of the last editor, or null for the never-edited default. */
  updatedByMemberId: string | null;
  /** When the brief was last edited, or null for the never-edited default. */
  updatedAt: Date | null;
}

/** The record returned for a workspace that has never had a brief written. */
export function emptyRecord(workspaceId: string): BriefRecord {
  return { workspaceId, brief: { ...EMPTY_BRIEF }, revision: 0, updatedByMemberId: null, updatedAt: null };
}

export interface SaveBriefInput {
  workspaceId: string;
  brief: CampaignBrief;
  /** The new revision (the caller computes `previous.revision + 1`). */
  revision: number;
  updatedByMemberId: string;
  updatedAt: Date;
}

export interface BriefStore {
  /** Load a workspace's brief record ({@link emptyRecord} at revision 0 if none yet). */
  get(workspaceId: string): Promise<BriefRecord>;
  /** Persist a workspace's brief record (upsert by workspace). Returns the saved record. */
  save(input: SaveBriefInput): Promise<BriefRecord>;
}

/**
 * In-memory {@link BriefStore} for unit tests. Deterministic: no clock or id generation of its own — the
 * caller supplies `revision`/`updatedAt`, so a test never depends on wall-clock time.
 */
export class InMemoryBriefStore implements BriefStore {
  private readonly records = new Map<string, BriefRecord>();

  async get(workspaceId: string): Promise<BriefRecord> {
    const rec = this.records.get(workspaceId);
    // Defensive copy so a caller mutating the returned brief never corrupts the store.
    return rec ? { ...rec, brief: { ...rec.brief } } : emptyRecord(workspaceId);
  }

  async save(input: SaveBriefInput): Promise<BriefRecord> {
    const rec: BriefRecord = {
      workspaceId: input.workspaceId,
      brief: { ...input.brief },
      revision: input.revision,
      updatedByMemberId: input.updatedByMemberId,
      updatedAt: input.updatedAt,
    };
    this.records.set(input.workspaceId, rec);
    return { ...rec, brief: { ...rec.brief } };
  }
}
