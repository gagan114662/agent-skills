/**
 * Persistence seam for the SEO content pipeline (issue #598). A narrow interface the service writes through:
 * create a run, read it back, list a workspace's runs, and apply a stage patch (the heart of resumability — the
 * full run state lives in the store, not the service, so a fresh service instance resumes mid-pipeline). The
 * production binding is the self-managed Postgres store in `default.ts`; unit tests inject
 * {@link InMemoryPipelineStore}, so the service is tested with no database.
 *
 * Everything is workspace-scoped (the `workspaceId` is the first argument / a column on every row) so a caller
 * can only ever read or mutate its own tenant's runs — the #3 IDOR boundary.
 */

import type {
  ContentBrief,
  ContentDraft,
  GateReason,
  KeywordSpec,
  PipelineRun,
  RunStage,
  RunStatus,
} from "./types.js";

/** Fields captured when a run is first created. */
export interface CreatePipelineRunInput {
  workspaceId: string;
  topic: string;
}

/**
 * A patch applied after one `advance` step. Every mutable field is present so a patch fully describes the run's
 * new state; the store overwrites them atomically. The store also enforces the optimistic precondition that the
 * run is still AT `expectedStage` (so two concurrent advances can never both act on the same stage).
 */
export interface PipelineRunPatch {
  /** The stage the run must currently be at for this patch to apply (optimistic concurrency guard). */
  expectedStage: RunStage;
  stage: RunStage;
  status: RunStatus;
  keyword: KeywordSpec | null;
  brief: ContentBrief | null;
  draft: ContentDraft | null;
  publishedUrl: string | null;
  indexReceiptId: string | null;
  publishApprovalId: string | null;
  indexApprovalId: string | null;
  blockedReasons: GateReason[];
  updatedAt: Date;
}

export interface PipelineStore {
  /** Append a new run at the `keyword` stage, `active`. */
  create(input: CreatePipelineRunInput, now: Date): Promise<PipelineRun>;
  /** Load one run within a workspace (#3 IDOR scoping). */
  get(workspaceId: string, id: string): Promise<PipelineRun | null>;
  /** A workspace's runs, newest first, optionally filtered by status. */
  list(workspaceId: string, status?: RunStatus): Promise<PipelineRun[]>;
  /**
   * Apply a stage patch to a run, but ONLY if it is still at `patch.expectedStage` (atomic compare-and-set).
   * Returns the updated run, or `null` if the run is missing or has moved on (so an advance can never run twice).
   */
  applyPatch(workspaceId: string, id: string, patch: PipelineRunPatch): Promise<PipelineRun | null>;
}

/**
 * In-memory {@link PipelineStore} for unit tests. Deterministic: ids are a monotonic counter and the clock is
 * injected through the service, so a test never depends on wall-clock time or a uuid.
 */
export class InMemoryPipelineStore implements PipelineStore {
  private readonly rows = new Map<string, PipelineRun>();
  private seq = 0;

  async create(input: CreatePipelineRunInput, now: Date): Promise<PipelineRun> {
    const id = `seo-${++this.seq}`;
    const row: PipelineRun = {
      id,
      workspaceId: input.workspaceId,
      topic: input.topic,
      stage: "keyword",
      status: "active",
      keyword: null,
      brief: null,
      draft: null,
      publishedUrl: null,
      indexReceiptId: null,
      publishApprovalId: null,
      indexApprovalId: null,
      blockedReasons: [],
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return clone(row);
  }

  async get(workspaceId: string, id: string): Promise<PipelineRun | null> {
    const row = this.rows.get(id);
    return row && row.workspaceId === workspaceId ? clone(row) : null;
  }

  async list(workspaceId: string, status?: RunStatus): Promise<PipelineRun[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId && (status === undefined || r.status === status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .map(clone);
  }

  async applyPatch(workspaceId: string, id: string, patch: PipelineRunPatch): Promise<PipelineRun | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.stage !== patch.expectedStage) return null;
    const next: PipelineRun = {
      ...row,
      stage: patch.stage,
      status: patch.status,
      keyword: patch.keyword,
      brief: patch.brief,
      draft: patch.draft,
      publishedUrl: patch.publishedUrl,
      indexReceiptId: patch.indexReceiptId,
      publishApprovalId: patch.publishApprovalId,
      indexApprovalId: patch.indexApprovalId,
      blockedReasons: patch.blockedReasons,
      updatedAt: patch.updatedAt,
    };
    this.rows.set(id, next);
    return clone(next);
  }
}

/** Deep-ish clone so callers can never mutate a stored row through the returned reference. */
function clone(row: PipelineRun): PipelineRun {
  return {
    ...row,
    keyword: row.keyword ? { ...row.keyword } : null,
    brief: row.brief ? { ...row.brief, outline: row.brief.outline.map((s) => ({ ...s })) } : null,
    draft: row.draft ? { ...row.draft, claims: row.draft.claims.map((c) => ({ ...c })) } : null,
    blockedReasons: row.blockedReasons.map((r) => ({ ...r })),
  };
}
