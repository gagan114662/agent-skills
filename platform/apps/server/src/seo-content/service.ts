/**
 * The SEO content pipeline service (issue #598) — the staged agent every content worker drives. It owns the
 * contract that makes "a post can only publish after passing every gate" structural:
 *
 *   1. create(workspaceId, { topic })              → start a run at the `keyword` stage. No stage is processed yet.
 *   2. advance(workspaceId, id, opts)              → process the CURRENT stage exactly once:
 *        keyword     → research + validate the keyword (gate). Pass ⇒ move to `brief`; fail ⇒ `blocked`.
 *        brief       → generate + completeness-check the brief (gate). Pass ⇒ `draft`; fail ⇒ `blocked`.
 *        draft       → generate + brand/fact-check the draft (gate). Pass ⇒ `publish`; fail ⇒ `blocked`.
 *        publish     → REQUIRES an approval id; publish the draft once. Success ⇒ `index_ping`; failure ⇒ blocked.
 *        index_ping  → REQUIRES an approval id; ping search engines once. Success ⇒ `done`/completed.
 *
 * The guardrails are structural, not advisory:
 *   - Each stage's gate is fail-closed → a run can never skip a stage, and a junk draft is caught at the
 *     brand/fact gate and never reaches `publish`.
 *   - `publish` and `index_ping` refuse without an `approvalRequestId` (the #13 swipe-approve flow) → nothing is
 *     ever published or pinged automatically.
 *   - With the master switch OFF, `advance` is an inert no-op (no provider is ever touched), so the default
 *     deployment cannot generate, publish, or ping.
 *   - The production providers are deterministic FAKES (`providers.ts`), so even enabled + approved does not make
 *     a live call until a real transport is wired in a separate change.
 *   - Resumability is structural: the full run state lives in the store, so a blocked run can be re-advanced after
 *     its input is fixed, and a fresh service instance resumes a run mid-pipeline.
 *
 * Like the #597 community agent, it does no IO except through the injected store, providers, and `now` seams,
 * touches no migration / schema barrel / app-wiring registry, and the credentials it forwards are tokens the
 * human supplied (caps) — it never collects passwords or runs OAuth itself.
 */

import { resolveSeoContentCaps, type SeoContentCaps } from "./caps.js";
import {
  computeKeywordRelevance,
  evaluateBriefGate,
  evaluateDraftGate,
  evaluateKeywordGate,
} from "./gates.js";
import { requiresApproval, transitionForGate } from "./pipeline.js";
import { createFakeProviders, type PipelineProviders } from "./providers.js";
import type { CreatePipelineRunInput, PipelineRunPatch, PipelineStore } from "./store.js";
import type {
  GateReason,
  IndexPingResult,
  KeywordSpec,
  PipelineRun,
  PipelineStage,
  PublishResult,
  RunStatus,
} from "./types.js";

export interface SeoContentServiceDeps {
  store: PipelineStore;
  /** Stage providers. Defaults to the deterministic FAKE registry (never makes a live call / publishes). */
  providers?: PipelineProviders;
  /** Resolved caps (master switch + credentials + gate policy). Defaults to env-resolved caps. */
  caps?: SeoContentCaps;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => Date;
}

/** Input to {@link SeoContentPipelineService.create}. */
export interface CreateRunInput {
  workspaceId: string;
  /** The human's seed intent for the piece (drives keyword relevance). */
  topic: string;
}

/** Options for one {@link SeoContentPipelineService.advance} step. */
export interface AdvanceOptions {
  /**
   * The #13 approval id authorizing this step. REQUIRED at the `publish` and `index_ping` stages — a side-effect
   * stage never runs without one. Ignored at the gate-only stages.
   */
  approvalRequestId?: string;
  /**
   * At the `keyword` stage, the candidate keyword to validate. Defaults to the run's topic. Supplying a corrected
   * keyword is how a caller resumes a run blocked at the keyword gate.
   */
  keyword?: string;
}

export class SeoContentPipelineService {
  private readonly store: PipelineStore;
  private readonly providers: PipelineProviders;
  private readonly caps: SeoContentCaps;
  private readonly now: () => Date;

  constructor(deps: SeoContentServiceDeps) {
    this.store = deps.store;
    this.providers = deps.providers ?? createFakeProviders();
    this.caps = deps.caps ?? resolveSeoContentCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** The resolved caps (read-only) — handy for a UI hint / health check. */
  get policy(): SeoContentCaps {
    return this.caps;
  }

  /** Start a new pipeline run for a topic. Persists intent only — no stage is processed until `advance`. */
  async create(input: CreateRunInput): Promise<PipelineRun> {
    if (input.topic.trim().length === 0) {
      throw new SeoContentError("topic is required");
    }
    const create: CreatePipelineRunInput = { workspaceId: input.workspaceId, topic: input.topic.trim() };
    return this.store.create(create, this.now());
  }

  /** A workspace's runs, newest first, optionally filtered by status. */
  async list(workspaceId: string, status?: RunStatus): Promise<PipelineRun[]> {
    return this.store.list(workspaceId, status);
  }

  /** Load one run within a workspace. */
  async get(workspaceId: string, id: string): Promise<PipelineRun | null> {
    return this.store.get(workspaceId, id);
  }

  /**
   * Process the run's current stage exactly once. Order of enforcement:
   *   1. The run must exist (IDOR-scoped) and not be terminal (`done`).
   *   2. With the agent disabled this is an inert no-op: no provider is touched and the run is returned unchanged
   *      (so it can resume once enabled).
   *   3. A side-effecting stage (`publish` / `index_ping`) requires an `approvalRequestId`, else it throws.
   *   4. The stage's provider runs and its gate / outcome decides whether the run advances or blocks.
   */
  async advance(workspaceId: string, id: string, opts: AdvanceOptions = {}): Promise<PipelineRun> {
    const run = await this.store.get(workspaceId, id);
    if (!run) throw new SeoContentError("no such run");
    if (run.stage === "done") throw new SeoContentError("run already completed");

    // (2) Disabled ⇒ inert no-op. No provider is ever touched; the run is returned unchanged.
    if (!this.caps.enabled) return run;

    const stage = run.stage;
    switch (stage) {
      case "keyword":
        return this.advanceKeyword(run, opts);
      case "brief":
        return this.advanceBrief(run);
      case "draft":
        return this.advanceDraft(run);
      case "publish":
        return this.advancePublish(run, opts);
      case "index_ping":
        return this.advanceIndexPing(run, opts);
      default:
        // Exhaustive: `stage` is narrowed to `never` here. A defensive throw keeps it total.
        throw new SeoContentError(`unprocessable stage: ${String(stage)}`);
    }
  }

  // --- Stage handlers ------------------------------------------------------------------------------------------

  private async advanceKeyword(run: PipelineRun, opts: AdvanceOptions): Promise<PipelineRun> {
    const candidate = (opts.keyword ?? run.topic).trim();
    const metrics = await this.providers.keyword.research({ topic: run.topic, keyword: candidate });
    const relevance = computeKeywordRelevance(metrics.keyword, run.topic);
    const gate = evaluateKeywordGate(metrics, relevance, this.caps.policy);
    const t = transitionForGate("keyword", gate);
    if (t.kind === "block") return this.commitBlock(run, "keyword", t.reasons);
    const keyword: KeywordSpec = { ...metrics, relevance };
    return this.commitAdvance(run, "keyword", { keyword });
  }

  private async advanceBrief(run: PipelineRun): Promise<PipelineRun> {
    const keyword = this.requireArtifact(run.keyword, "brief", "keyword");
    const brief = await this.providers.brief.generate({ keyword: keyword.keyword, topic: run.topic });
    const gate = evaluateBriefGate(brief, keyword.keyword, this.caps.policy);
    const t = transitionForGate("brief", gate);
    if (t.kind === "block") return this.commitBlock(run, "brief", t.reasons);
    return this.commitAdvance(run, "brief", { brief });
  }

  private async advanceDraft(run: PipelineRun): Promise<PipelineRun> {
    const brief = this.requireArtifact(run.brief, "draft", "brief");
    const draft = await this.providers.draft.generate({ brief });
    const gate = evaluateDraftGate(draft, brief, this.caps.policy);
    const t = transitionForGate("draft", gate);
    if (t.kind === "block") return this.commitBlock(run, "draft", t.reasons);
    return this.commitAdvance(run, "draft", { draft });
  }

  private async advancePublish(run: PipelineRun, opts: AdvanceOptions): Promise<PipelineRun> {
    const approvalId = this.requireApproval(opts, "publish");
    const draft = this.requireArtifact(run.draft, "publish", "draft");
    const credential = this.caps.credentials.publish;
    let result: PublishResult;
    try {
      result = await this.providers.publish.publish({
        runId: run.id,
        title: draft.title,
        body: draft.body,
        credential,
      });
    } catch (err) {
      result = { status: "failed", url: null, error: err instanceof Error ? err.message : "publish threw" };
    }
    if (result.status === "ok" && result.url) {
      return this.commitAdvance(run, "publish", { publishedUrl: result.url, publishApprovalId: approvalId });
    }
    // A failed publish records the approval that authorized the attempt and leaves the run blocked-and-resumable.
    return this.commitBlock(
      run,
      "publish",
      [{ code: "publish_failed", message: result.error ?? "publish failed" }],
      { publishApprovalId: approvalId },
    );
  }

  private async advanceIndexPing(run: PipelineRun, opts: AdvanceOptions): Promise<PipelineRun> {
    const approvalId = this.requireApproval(opts, "index_ping");
    const url = run.publishedUrl;
    if (!url) throw new SeoContentError("invariant: index_ping stage with no published URL");
    const credential = this.caps.credentials.index;
    let result: IndexPingResult;
    try {
      result = await this.providers.index.ping({ runId: run.id, url, credential });
    } catch (err) {
      result = { status: "failed", receiptId: null, error: err instanceof Error ? err.message : "index ping threw" };
    }
    if (result.status === "ok" && result.receiptId) {
      return this.commitAdvance(run, "index_ping", {
        indexReceiptId: result.receiptId,
        indexApprovalId: approvalId,
      });
    }
    return this.commitBlock(
      run,
      "index_ping",
      [{ code: "index_ping_failed", message: result.error ?? "index ping failed" }],
      { indexApprovalId: approvalId },
    );
  }

  // --- Commit helpers ------------------------------------------------------------------------------------------

  /** The current artifact values — the base every patch starts from so a block never wipes earlier stages' work. */
  private baseFields(run: PipelineRun) {
    return {
      keyword: run.keyword,
      brief: run.brief,
      draft: run.draft,
      publishedUrl: run.publishedUrl,
      indexReceiptId: run.indexReceiptId,
      publishApprovalId: run.publishApprovalId,
      indexApprovalId: run.indexApprovalId,
    };
  }

  /** Advance the run to the next stage (or `done`/`completed` from the last stage), merging `produced` fields. */
  private async commitAdvance(
    run: PipelineRun,
    stage: PipelineStage,
    produced: Partial<ReturnType<SeoContentPipelineService["baseFields"]>>,
  ): Promise<PipelineRun> {
    const t = transitionForGate(stage, { decision: "allow", reasons: [] });
    // `t.kind` is always "advance" for an allow decision.
    const to = t.kind === "advance" ? t.to : stage;
    const status: RunStatus = to === "done" ? "completed" : "active";
    const patch: PipelineRunPatch = {
      expectedStage: stage,
      stage: to,
      status,
      ...this.baseFields(run),
      ...produced,
      blockedReasons: [],
      updatedAt: this.now(),
    };
    return this.commit(run.workspaceId, run.id, patch, stage);
  }

  /** Block the run AT `stage` with `reasons`, optionally recording approval ids from a failed side-effect. */
  private async commitBlock(
    run: PipelineRun,
    stage: PipelineStage,
    reasons: GateReason[],
    produced: Partial<ReturnType<SeoContentPipelineService["baseFields"]>> = {},
  ): Promise<PipelineRun> {
    const patch: PipelineRunPatch = {
      expectedStage: stage,
      stage,
      status: "blocked",
      ...this.baseFields(run),
      ...produced,
      blockedReasons: reasons,
      updatedAt: this.now(),
    };
    return this.commit(run.workspaceId, run.id, patch, stage);
  }

  /** Apply a patch, surfacing the lost-race case (run moved on) as a clear error. */
  private async commit(
    workspaceId: string,
    id: string,
    patch: PipelineRunPatch,
    stage: PipelineStage,
  ): Promise<PipelineRun> {
    const committed = await this.store.applyPatch(workspaceId, id, patch);
    if (!committed) {
      throw new SeoContentError(`advance could not be recorded (run no longer at ${stage})`);
    }
    return committed;
  }

  /** Require an approval id at a side-effecting stage, else refuse — a stage never runs from an unapproved item. */
  private requireApproval(opts: AdvanceOptions, stage: PipelineStage): string {
    if (!requiresApproval(stage)) return "";
    const id = (opts.approvalRequestId ?? "").trim();
    if (id.length === 0) {
      throw new SeoContentError(`${stage} requires an approved item (no approvalRequestId)`);
    }
    return id;
  }

  /** Narrow a required prior-stage artifact, throwing a clear invariant error if it is somehow absent. */
  private requireArtifact<T>(value: T | null, stage: PipelineStage, needed: PipelineStage): T {
    if (value === null) {
      throw new SeoContentError(`invariant: ${stage} stage reached without a ${needed} artifact`);
    }
    return value;
  }
}

/** A pipeline operation rejected for a stated reason (mapped to 4xx at any route layer). */
export class SeoContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeoContentError";
  }
}
