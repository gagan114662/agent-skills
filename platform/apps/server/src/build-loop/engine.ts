import type { SessionLogger } from "../runtime/manager.js";
import { recordBuildLoopAction, recordBuildLoopTick, recordLoopTickFailure } from "../observability/metrics.js";
import type { BuildLoopCaps } from "./caps.js";
import {
  decideDispatch,
  decideMergeGuardrails,
  decideNextIssue,
  decidePostMerge,
  decideRebase,
  decideReviewOutcome,
} from "./decide.js";
import {
  buildCapacityAvailable,
  diffWithinSizeCap,
  protectedPathsTouched,
} from "./guardrails.js";
import { evaluateHouseRubric } from "./rubric.js";
import {
  issueNumberOf,
  renderBuildTask,
  renderEscalationSummary,
  renderFindings,
  renderRevisionTask,
  renderVerdictComment,
} from "./render.js";
import type { BuildRunRecord, BuildRunStatus, IssueCandidate, ReviewAssessment } from "./types.js";
import { DEFAULT_WORKSPACE_LOOP_CONCURRENCY, runBounded } from "../loops/concurrency.js";

/**
 * BuildLoopEngine (#172, ADR-0172) — the self-shipping loop. It platform-ifies the loop the owner has
 * been running by hand: watch agent-ok issues → dispatch a cloud build session → auto-review the PR
 * against the house rubric → auto-merge ONLY within guardrails (else escalate) → rebase-train open PRs
 * on a main move → post-merge verify (proposing, never executing, a revert).
 *
 * Like the #117 flywheel it is a tick-driven supervisor with a PURE decision core (`decide.ts`/
 * `guardrails.ts`/`rubric.ts`) and every side effect behind an injected seam, so it is unit- and
 * integration-tested against fakes with zero model/GitHub spend. Gating mirrors the flywheel: maintenance
 * before any DB call, then per-workspace the config `enabled` flag and the #17 kill switch. Default-OFF.
 */

// ---- store seams (real impls wrap the `build_loop_runs` / `build_loop_reviews` repos) -----------

export interface RunStore {
  /** Insert a freshly-seen agent-ok issue as a `queued` run, or return the existing run (dedup by ref). */
  upsertQueued(input: {
    workspaceId: string;
    issueRef: string;
    issueTitle: string;
    priority: number;
    dependsOn: string | null;
    agentOk: boolean;
    targetChannelId: string | null;
    targetAgentMemberId: string | null;
    now: Date;
  }): Promise<BuildRunRecord>;
  get(workspaceId: string, id: string): Promise<BuildRunRecord | null>;
  getByIssueRef(workspaceId: string, issueRef: string): Promise<BuildRunRecord | null>;
  /** Non-terminal runs (status ∉ {merged, escalated, failed}) — the tick work-list. */
  listActive(workspaceId: string): Promise<BuildRunRecord[]>;
  /** Issue refs of merged runs (to clear a candidate's dependency). */
  listMergedRefs(workspaceId: string): Promise<string[]>;
  /** Apply a status/field patch to a run. */
  update(input: {
    id: string;
    patch: Partial<
      Pick<
        BuildRunRecord,
        | "status"
        | "reviewRounds"
        | "buildSessionId"
        | "prRef"
        | "prHeadBranch"
        | "mergeRef"
        | "escalationReason"
        | "agentOk"
        | "priority"
        | "dependsOn"
      >
    >;
    now: Date;
  }): Promise<BuildRunRecord>;
  /** Recent runs for the #104 console pane (queue / in-flight / merge history). */
  listForConsole(workspaceId: string): Promise<BuildRunRecord[]>;
}

export interface ReviewStore {
  create(input: {
    workspaceId: string;
    runId: string;
    round: number;
    verdict: "pass" | "fail";
    summary: string;
    findings: string;
    reviewerSessionId: string | null;
    now: Date;
  }): Promise<void>;
  listForConsole(workspaceId: string): Promise<
    Array<{ runId: string; round: number; verdict: "pass" | "fail"; summary: string; createdAt: Date }>
  >;
}

// ---- IO seams ----------------------------------------------------------------------------------

/** The structured PR diff the reviewer + guardrails read (paths + change volume + added lines). */
export interface PrDiff {
  files: string[];
  additions: number;
  deletions: number;
  addedLines: string[];
}

/**
 * The repo-host surface the loop drives. The default (no credentials) implementation is a no-op so CI/
 * tests never reach GitHub; a deployment configures the real `gh`-backed provider. Merge is the only
 * mutating call and it is reached ONLY after `decideMergeGuardrails` returns `merge`.
 */
export interface RepoHost {
  /** Did the build session open a PR yet? Returns the ref + head branch, or null while still building. */
  observePr(input: { workspaceId: string; run: BuildRunRecord }): Promise<{ prRef: string; headBranch: string } | null>;
  /** The PR's diff (for the reviewer + the size/protected-path guardrails). */
  getDiff(input: { workspaceId: string; prRef: string }): Promise<PrDiff>;
  /** Whether the PR's CI checks are all green. */
  ciGreen(input: { workspaceId: string; prRef: string }): Promise<boolean>;
  /** Post the structured reviewer verdict comment on the PR. */
  comment(input: { workspaceId: string; prRef: string; body: string }): Promise<void>;
  /** Apply the merge (reached only when all guardrails hold). Returns the merge ref. */
  merge(input: { workspaceId: string; prRef: string }): Promise<{ mergeRef: string }>;
  /** Rebase-train: merge main into the PR branch. `conflicted` routes it back to the build session. */
  updateFromMain(input: { workspaceId: string; prRef: string }): Promise<{ conflicted: boolean }>;
}

/** The build/review/fix session-launch surface — the #92 AutonomyLauncher satisfies it in `default.ts`. */
export interface BuildLauncher {
  launch(input: {
    workspaceId: string;
    run: BuildRunRecord;
    task: string;
    role: "build" | "review" | "revise";
  }): Promise<{ id: string }>;
}

/** The reviewer seam. Default = the pure house rubric over the diff; production wraps a model session. */
export interface Reviewer {
  review(input: { workspaceId: string; run: BuildRunRecord; diff: PrDiff }): Promise<ReviewAssessment>;
}

/** The owner-escalation surface — the #13 approval queue / #148 pager. Never auto-merges. */
export interface Escalator {
  escalate(input: { workspaceId: string; run: BuildRunRecord; reason: string; summary: string }): Promise<void>;
}

/** Optional post-merge verifier (#171 self-QA subset). Returns the regression count + a short detail. */
export interface PostMergeVerifier {
  verify(input: { workspaceId: string; run: BuildRunRecord }): Promise<{ regressions: number; detail: string }>;
}

/** Optional issue source — watch the repo for agent-ok issues and feed them into the queue each tick. */
export interface IssueSource {
  listAgentOk(workspaceId: string): Promise<IssueCandidate[]>;
}

export interface BuildLoopEngineDeps {
  runs: RunStore;
  reviews: ReviewStore;
  repo: RepoHost;
  launcher: BuildLauncher;
  reviewer: Reviewer;
  escalator: Escalator;
  verifier?: PostMergeVerifier;
  issueSource?: IssueSource;
  /** Resolve the per-workspace caps (config; default OFF). */
  caps: (workspaceId: string) => BuildLoopCaps;
  /** The #17 kill switch for a workspace (halts its tick). */
  killSwitch: (workspaceId: string) => Promise<boolean>;
  /** Whether the workspace has met/passed its #71 dollar ceiling (skip new dispatch). */
  budgetExhausted: (workspaceId: string, now: Date) => Promise<boolean>;
  /** Redact a string against a session's secret values before persist/post (#25). */
  redact: (text: string) => string;
  /** Workspaces with non-terminal runs (the tick work-list). */
  activeWorkspaces: () => Promise<string[]>;
  /** Optional maintenance-pause check (#99) — when true, `tickAll()` skips BEFORE any DB call. */
  maintenancePaused?: () => Promise<boolean>;
  logger: SessionLogger;
  workspaceConcurrency?: number;
  /** Clock seam — defaults to `new Date()`; tests inject a fixed clock. */
  now?: () => Date;
}

/** What one tick did to a workspace (for the route response + tests). */
export interface WorkspaceTickResult {
  workspaceId: string;
  skipped?: "disabled" | "kill_switch";
  ingested: number;
  dispatches: Array<{ issueRef: string; action: "dispatch" | "skip"; reason: string }>;
  advances: Array<{ runId: string; from: BuildRunStatus; to: BuildRunStatus; reason: string }>;
}

const TERMINAL: ReadonlySet<BuildRunStatus> = new Set(["merged", "escalated", "failed"]);

export class BuildLoopEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: BuildLoopEngineDeps) {}

  private clock(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Start the periodic loop. No-op if interval ≤ 0 or already started. */
  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tickAll(), intervalMs);
    this.timer.unref?.();
  }

  /** Stop the periodic loop (idempotent) — called on server shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Record an agent-ok issue as a `queued` run (dedup by issue ref). Always available + tenant-scoped —
   * this is the explicit ingest path (a route, the self-QA loop); the optional `IssueSource` is the
   * watch path the tick also pulls from.
   */
  async recordIssue(
    workspaceId: string,
    input: {
      issueRef: string;
      issueTitle: string;
      priority?: number;
      dependsOn?: string | null;
      agentOk?: boolean;
      targetChannelId?: string | null;
      targetAgentMemberId?: string | null;
    },
  ): Promise<BuildRunRecord> {
    return this.deps.runs.upsertQueued({
      workspaceId,
      issueRef: input.issueRef,
      issueTitle: input.issueTitle,
      priority: input.priority ?? 0,
      dependsOn: input.dependsOn ?? null,
      agentOk: input.agentOk ?? false,
      targetChannelId: input.targetChannelId ?? null,
      targetAgentMemberId: input.targetAgentMemberId ?? null,
      now: this.clock(),
    });
  }

  /** Read the recent runs for a workspace (the route + console queue / in-flight / merge history). */
  async listRuns(workspaceId: string): Promise<BuildRunRecord[]> {
    return this.deps.runs.listForConsole(workspaceId);
  }

  /** Loop closure helper for external callers (e.g. a route): page the owner about a run. */
  async escalate(workspaceId: string, runId: string, reason: string): Promise<void> {
    const run = await this.deps.runs.get(workspaceId, runId);
    if (!run) return;
    await this.applyEscalation(run, reason, this.clock());
  }

  /** One pass over every workspace with non-terminal runs. */
  async tickAll(): Promise<void> {
    try {
      // #99: a maintenance window stops the whole loop BEFORE any DB call.
      if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) {
        this.deps.logger.warn({}, "build-loop tickAll skipped: maintenance mode active");
        return;
      }
      const now = this.clock();
      await runBounded(
        await this.deps.activeWorkspaces(),
        this.deps.workspaceConcurrency ?? DEFAULT_WORKSPACE_LOOP_CONCURRENCY,
        async (workspaceId) => {
          try {
            await this.tickWorkspace(workspaceId, now);
          } catch (err) {
            this.deps.logger.error({ err, workspaceId }, "build-loop tickAll: workspace tick failed");
          }
        },
      );
    } catch (err) {
      recordLoopTickFailure("build_loop");
      this.deps.logger.error({ err }, "build-loop tickAll failed");
    }
  }

  /**
   * One pass over a single workspace: (0) ingest watched agent-ok issues, (1) advance every in-flight run
   * one step, (2) dispatch queued issues under the concurrency cap. The config flag and the kill switch
   * gate the whole pass first (mirrors the flywheel).
   */
  async tickWorkspace(workspaceId: string, now: Date): Promise<WorkspaceTickResult> {
    recordBuildLoopTick();
    const log = this.deps.logger.child({ workspaceId, component: "build-loop" });
    const result: WorkspaceTickResult = { workspaceId, ingested: 0, dispatches: [], advances: [] };

    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return { ...result, skipped: "disabled" };

    if (await this.deps.killSwitch(workspaceId)) {
      log.warn({}, "build-loop tick skipped: kill switch engaged");
      recordBuildLoopAction("noop:kill_switch");
      return { ...result, skipped: "kill_switch" };
    }

    // --- (0) ingest watched agent-ok issues (optional source) ----------------------------------
    if (this.deps.issueSource) {
      for (const candidate of await this.deps.issueSource.listAgentOk(workspaceId)) {
        const existing = await this.deps.runs.getByIssueRef(workspaceId, candidate.issueRef);
        if (!existing) {
          await this.deps.runs.upsertQueued({
            workspaceId,
            issueRef: candidate.issueRef,
            issueTitle: candidate.title,
            priority: candidate.priority,
            dependsOn: candidate.dependsOn,
            agentOk: candidate.agentOk,
            targetChannelId: null,
            targetAgentMemberId: null,
            now,
          });
          result.ingested += 1;
          recordBuildLoopAction("ingest:new");
        }
      }
    }

    const active = await this.deps.runs.listActive(workspaceId);

    // --- (1) advance in-flight runs one step each ----------------------------------------------
    for (const run of active.filter((r) => r.status !== "queued")) {
      try {
        const advanced = await this.advanceRun(run, caps, now, log);
        if (advanced) result.advances.push(advanced);
      } catch (err) {
        log.error({ err, runId: run.id }, "build-loop: advancing a run failed");
      }
    }

    // --- (2) dispatch queued runs under the concurrency cap -------------------------------------
    const budgetExhausted = await this.deps.budgetExhausted(workspaceId, now);
    const mergedRefs = new Set(await this.deps.runs.listMergedRefs(workspaceId));
    // Re-read so a run that just advanced out of queued/into terminal is reflected in the in-flight count.
    const afterAdvance = await this.deps.runs.listActive(workspaceId);
    const queued = afterAdvance.filter((r) => r.status === "queued");
    const inFlightRefs = new Set(afterAdvance.filter((r) => r.status !== "queued").map((r) => r.issueRef));
    let inFlight = inFlightRefs.size;

    for (;;) {
      const candidate = decideNextIssue({
        candidates: queued.map(toCandidate),
        inFlightRefs,
        mergedRefs,
      });
      if (!candidate) break;
      const run = queued.find((r) => r.issueRef === candidate.issueRef);
      if (!run) break;

      const decision = decideDispatch({
        killSwitchEngaged: false, // the whole tick is already kill-switch-gated above
        agentOk: run.agentOk,
        budgetExhausted,
        concurrencyAvailable: buildCapacityAvailable(inFlight, caps.maxConcurrentBuilds),
      });
      result.dispatches.push({ issueRef: run.issueRef, action: decision.action, reason: decision.reason });

      if (decision.action === "skip") {
        recordBuildLoopAction(`dispatch:skip:${decision.reason}`);
        // A capacity/budget skip ends the dispatch loop (nothing else will fit either); an agent-ok skip
        // just removes this candidate from contention so the next-best can be considered.
        if (decision.reason === "concurrency_cap" || decision.reason === "budget_exhausted") break;
        inFlightRefs.add(run.issueRef); // exclude from the next decideNextIssue pass
        continue;
      }

      const session = await this.deps.launcher.launch({
        workspaceId,
        run,
        task: renderBuildTask(run),
        role: "build",
      });
      await this.deps.runs.update({
        id: run.id,
        patch: { status: "building", buildSessionId: session.id },
        now,
      });
      recordBuildLoopAction("dispatch:build");
      inFlightRefs.add(run.issueRef);
      inFlight += 1;
    }

    return result;
  }

  /** Advance one non-queued run a single step, returning what changed (or null for a no-op). */
  private async advanceRun(
    run: BuildRunRecord,
    caps: BuildLoopCaps,
    now: Date,
    log: SessionLogger,
  ): Promise<{ runId: string; from: BuildRunStatus; to: BuildRunStatus; reason: string } | null> {
    if (run.status === "building" || run.status === "revising") {
      const pr = await this.deps.repo.observePr({ workspaceId: run.workspaceId, run });
      if (!pr) return null; // still working
      await this.deps.runs.update({
        id: run.id,
        patch: { status: "reviewing", prRef: pr.prRef, prHeadBranch: pr.headBranch },
        now,
      });
      recordBuildLoopAction("advance:reviewing");
      return { runId: run.id, from: run.status, to: "reviewing", reason: "pr_opened" };
    }

    if (run.status === "reviewing") {
      return this.reviewRun({ ...run, prHeadBranch: run.prHeadBranch }, caps, now, log);
    }

    return null;
  }

  /** Run the reviewer on an open PR, then route on the verdict (merge-eval / revise / escalate). */
  private async reviewRun(
    run: BuildRunRecord,
    caps: BuildLoopCaps,
    now: Date,
    log: SessionLogger,
  ): Promise<{ runId: string; from: BuildRunStatus; to: BuildRunStatus; reason: string } | null> {
    if (!run.prRef) return null;
    const diff = await this.deps.repo.getDiff({ workspaceId: run.workspaceId, prRef: run.prRef });
    const assessment = await this.deps.reviewer.review({ workspaceId: run.workspaceId, run, diff });
    const round = run.reviewRounds + 1;

    // Persist the (redacted) review row and post the structured verdict comment on the PR.
    await this.deps.reviews.create({
      workspaceId: run.workspaceId,
      runId: run.id,
      round,
      verdict: assessment.verdict,
      summary: this.deps.redact(assessment.summary),
      findings: renderFindings(assessment, this.deps.redact),
      reviewerSessionId: null,
      now,
    });
    await this.deps.repo.comment({
      workspaceId: run.workspaceId,
      prRef: run.prRef,
      body: this.deps.redact(renderVerdictComment({ ...run, reviewRounds: round }, assessment)),
    });
    recordBuildLoopAction(`review:${assessment.verdict}`);

    const outcome = decideReviewOutcome(assessment.verdict, run.reviewRounds, caps.maxReviewRounds);

    if (outcome.action === "revise") {
      const updated = { ...run, reviewRounds: round };
      const session = await this.deps.launcher.launch({
        workspaceId: run.workspaceId,
        run: updated,
        task: renderRevisionTask(updated, assessment),
        role: "revise",
      });
      await this.deps.runs.update({
        id: run.id,
        patch: { status: "revising", reviewRounds: round, buildSessionId: session.id },
        now,
      });
      recordBuildLoopAction("advance:revising");
      return { runId: run.id, from: "reviewing", to: "revising", reason: outcome.reason };
    }

    if (outcome.action === "escalate") {
      await this.deps.runs.update({ id: run.id, patch: { reviewRounds: round }, now });
      await this.applyEscalation({ ...run, reviewRounds: round }, outcome.reason, now);
      return { runId: run.id, from: "reviewing", to: "escalated", reason: outcome.reason };
    }

    // merge_eval: evaluate ALL the auto-merge guardrails (the safety core).
    await this.deps.runs.update({ id: run.id, patch: { reviewRounds: round }, now });
    return this.evaluateMerge({ ...run, reviewRounds: round }, diff, caps, now, log);
  }

  /** Evaluate the merge guardrails on a PASSed PR; merge within guardrails, else escalate. */
  private async evaluateMerge(
    run: BuildRunRecord,
    diff: PrDiff,
    caps: BuildLoopCaps,
    now: Date,
    log: SessionLogger,
  ): Promise<{ runId: string; from: BuildRunStatus; to: BuildRunStatus; reason: string }> {
    if (!run.prRef) {
      await this.applyEscalation(run, "reviewer_fail", now);
      return { runId: run.id, from: "reviewing", to: "escalated", reason: "no_pr" };
    }
    const protectedTouched = protectedPathsTouched(diff.files, caps.protectedPaths);
    const withinCap = diffWithinSizeCap(
      diff.files.length,
      diff.additions + diff.deletions,
      caps.maxDiffFiles,
      caps.maxDiffLines,
    );
    const ciGreen = await this.deps.repo.ciGreen({ workspaceId: run.workspaceId, prRef: run.prRef });

    const decision = decideMergeGuardrails({
      agentOkLabeled: run.agentOk,
      reviewerPass: true,
      ciGreen,
      protectedPathTouched: protectedTouched.length > 0,
      diffWithinSizeCap: withinCap,
    });

    if (decision.action === "escalate") {
      await this.applyEscalation(run, decision.reason, now);
      return { runId: run.id, from: "reviewing", to: "escalated", reason: decision.reason };
    }

    // merge within guardrails.
    await this.deps.runs.update({ id: run.id, patch: { status: "merging" }, now });
    const { mergeRef } = await this.deps.repo.merge({ workspaceId: run.workspaceId, prRef: run.prRef });
    await this.deps.runs.update({ id: run.id, patch: { status: "merged", mergeRef }, now });
    recordBuildLoopAction("merge:auto");
    log.info({ runId: run.id, prRef: run.prRef, mergeRef }, "build-loop: auto-merged within guardrails");

    // post-merge verify (criterion 5): smoke + the #171 self-QA subset; a regression PROPOSES a revert.
    if (this.deps.verifier) {
      const { regressions, detail } = await this.deps.verifier.verify({ workspaceId: run.workspaceId, run });
      const post = decidePostMerge(regressions);
      if (post.action === "propose_revert") {
        await this.applyEscalation({ ...run, status: "merged", mergeRef }, post.reason, now, detail);
        recordBuildLoopAction("post_merge:propose_revert");
      } else {
        recordBuildLoopAction("post_merge:clean");
      }
    }

    return { runId: run.id, from: "merging", to: "merged", reason: "guardrails_pass" };
  }

  /** Rebase-train (criterion 4): on a main move, attempt merge-from-main on every open PR. */
  async onMainMoved(workspaceId: string, now = this.clock()): Promise<void> {
    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return;
    if (await this.deps.killSwitch(workspaceId)) return;
    const active = await this.deps.runs.listActive(workspaceId);
    for (const run of active.filter((r) => r.prRef && !TERMINAL.has(r.status))) {
      if (!run.prRef) continue;
      try {
        const { conflicted } = await this.deps.repo.updateFromMain({ workspaceId, prRef: run.prRef });
        const decision = decideRebase(conflicted);
        if (decision.action === "route_back") {
          const session = await this.deps.launcher.launch({
            workspaceId,
            run,
            task: renderRevisionTask(run, {
              verdict: "fail",
              summary: "Merge-from-main conflict — resolve and push to the PR branch.",
              checks: [],
            }),
            role: "revise",
          });
          await this.deps.runs.update({
            id: run.id,
            patch: { status: "revising", buildSessionId: session.id },
            now,
          });
          recordBuildLoopAction("rebase:route_back");
        } else {
          recordBuildLoopAction("rebase:continue");
        }
      } catch (err) {
        this.deps.logger.error({ err, runId: run.id }, "build-loop: rebase-train step failed");
      }
    }
  }

  /** Move a run to `escalated` (unless already terminal-merged) and page the owner — never merge. */
  private async applyEscalation(
    run: BuildRunRecord,
    reason: string,
    now: Date,
    extraDetail?: string,
  ): Promise<void> {
    if (run.status !== "merged") {
      await this.deps.runs.update({ id: run.id, patch: { status: "escalated", escalationReason: reason }, now });
    }
    const summary = this.deps.redact(
      renderEscalationSummary(run, reason) + (extraDetail ? ` — ${extraDetail}` : ""),
    );
    await this.deps.escalator.escalate({ workspaceId: run.workspaceId, run, reason, summary });
    recordBuildLoopAction(`escalate:${reason}`);
  }
}

function toCandidate(run: BuildRunRecord): IssueCandidate {
  return {
    issueRef: run.issueRef,
    title: run.issueTitle,
    priority: run.priority,
    dependsOn: run.dependsOn,
    agentOk: run.agentOk,
  };
}

/** Re-export so callers don't reach past the engine for the issue-number helper. */
export { issueNumberOf, evaluateHouseRubric };
