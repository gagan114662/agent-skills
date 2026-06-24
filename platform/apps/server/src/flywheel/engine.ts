import type { SessionLogger } from "../runtime/manager.js";
import {
  recordFlywheelAction,
  recordFlywheelTick,
  recordLoopTickFailure,
} from "../observability/metrics.js";
import { resolveFlywheelCaps, type FlywheelCaps } from "./caps.js";
import { decideDispatch, decideIssueAction } from "./decide.js";
import { concurrencyAvailable, withinRateLimit } from "./guards.js";
import { fingerprintFailure } from "./fingerprint.js";
import { rankFingerprints } from "./rank.js";
import {
  buildSampleContext,
  renderFixTask,
  renderIssueBody,
  renderRecurrenceComment,
  renderReopenComment,
} from "./render.js";
import type {
  DispatchAction,
  FailureClass,
  FailureEvent,
  FingerprintRecord,
  FingerprintStatus,
  FixDispatchRecord,
  IssueAction,
} from "./types.js";

/**
 * FlywheelEngine (#117, ADR-0117) — the second infrastructure-time supervisor, mirroring the #105
 * watchdog wholesale. `record()` fingerprints + dedups + redacts a failure into a durable row; the
 * opt-in `tickAll()`/`tickWorkspace()` synthesize GitHub issues (ONE open per fingerprint, rate-limited)
 * and dispatch budget-capped, concurrency-capped fixes (auto for #95-allowed classes, else queued for a
 * human); `markFixed()` closes the loop, and a later recurrence reopens escalated + excluded.
 *
 * The decision is pure (`decide.ts`); every side effect (redact+persist, file, launch, enqueue) is a
 * seam here. Gating is identical to the watchdog: maintenance before any DB call, then per-workspace
 * the config `enabled` flag and the #17 kill switch.
 */

// ---- store seams (real impls wrap the `failure_fingerprints` / `flywheel_fix_dispatches` repos) ----

export interface FingerprintStore {
  /** The fingerprint for this signature in this workspace, or null. */
  getBySignature(workspaceId: string, signature: string): Promise<FingerprintRecord | null>;
  /** Insert a freshly-seen fingerprint (occurrence count 1) with the REDACTED sample bundle. */
  insert(input: {
    workspaceId: string;
    signature: string;
    failureClass: FailureClass;
    title: string;
    sampleContext: string;
    originChannelId?: string | null;
    originAgentMemberId?: string | null;
    now: Date;
  }): Promise<FingerprintRecord>;
  /** A repeat occurrence: ++count, bump last_seen (keep the first, stable sample). */
  touch(input: { id: string; now: Date }): Promise<FingerprintRecord>;
  /** A recurrence after fix: status `recurred`, excluded from auto-dispatch, escalated (#106). */
  markRecurred(input: { id: string; now: Date }): Promise<FingerprintRecord>;
  /** Fingerprints still needing attention (status ≠ `fixed`), for a workspace's tick. */
  listOpen(workspaceId: string): Promise<FingerprintRecord[]>;
  /** Persist the issue linkage after a draft / comment / reopen (the dedup anchor + sync cursor). */
  recordIssue(input: {
    id: string;
    issueRef: string;
    issueState: string;
    status: FingerprintStatus;
    syncedOccurrenceCount: number;
    now: Date;
  }): Promise<void>;
  /** Link a dispatched fix session and move the fingerprint to `fixing`. */
  linkFix(input: { id: string; fixSessionId: string; now: Date }): Promise<void>;
  /** Loop closure: a merged fix links its fingerprint (status `fixed`). */
  markFixed(input: { id: string; fixRef: string; now: Date }): Promise<FingerprintRecord>;
  /** Read one fingerprint by id (workspace-scoped). */
  get(workspaceId: string, id: string): Promise<FingerprintRecord | null>;
  /** Recent fingerprints for the #104 console pane. */
  listForConsole(workspaceId: string): Promise<FingerprintRecord[]>;
}

export interface FixDispatchStore {
  create(input: {
    workspaceId: string;
    fingerprintId: string;
    mode: "auto" | "queued";
    status: "dispatched" | "queued";
    sessionId?: string | null;
    approvalRequestId?: string | null;
    reason: string;
    now: Date;
  }): Promise<FixDispatchRecord>;
  /** In-flight auto fixes (mode auto + status dispatched) — the hard concurrency cap input. */
  countActive(workspaceId: string): Promise<number>;
  /** Recent dispatches for the #104 console pane. */
  listForConsole(workspaceId: string): Promise<FixDispatchRecord[]>;
}

/** The GitHub issue surface the flywheel drives — the #57 provider path satisfies it (default no-op). */
export interface IssueFiler {
  create(input: {
    workspaceId: string;
    title: string;
    body: string;
    labels?: string[];
  }): Promise<{ ref: string; state: string }>;
  comment(input: { workspaceId: string; ref: string; body: string }): Promise<void>;
  reopen(input: { workspaceId: string; ref: string }): Promise<{ state: string }>;
}

/** The session-launch surface for a fix agent — the #92 {@link AutonomyLauncher} satisfies it. */
export interface FixLauncher {
  launch(input: {
    workspaceId: string;
    fingerprint: FingerprintRecord;
    task: string;
    harnessEnv?: Record<string, string>;
  }): Promise<{ id: string }>;
}

/** The #13 approval queue for a fix that is NOT auto-allowed (surfaced in the #104 console). */
export interface FixApprovalQueue {
  enqueue(input: {
    workspaceId: string;
    fingerprint: FingerprintRecord;
    reason: string;
  }): Promise<{ id: string }>;
}

export interface FlywheelEngineDeps {
  fingerprints: FingerprintStore;
  dispatches: FixDispatchStore;
  filer: IssueFiler;
  launcher: FixLauncher;
  approvalQueue: FixApprovalQueue;
  /** Resolve the per-workspace flywheel caps (config; default OFF). */
  caps: (workspaceId: string) => FlywheelCaps;
  /** The #17 kill switch for a workspace (halts its tick). */
  killSwitch: (workspaceId: string) => Promise<boolean>;
  /** Whether the workspace has met/passed its #71 dollar ceiling (skip dispatch). */
  budgetExhausted: (workspaceId: string, now: Date) => Promise<boolean>;
  /** Whether a #95 policy rule auto-approves this fingerprint's class (sensitive-by-default). */
  autoDispatchAllowed: (workspaceId: string, failureClass: FailureClass) => Promise<boolean>;
  /** Redact a string against the event's secret values (#25). */
  redact: (text: string, secrets: Record<string, string>) => string;
  /** Workspaces with non-terminal fingerprints (the tick work-list). */
  activeWorkspaces: () => Promise<string[]>;
  /** Optional maintenance-pause check (#99) — when true, `tickAll()` skips BEFORE any DB call. */
  maintenancePaused?: () => Promise<boolean>;
  logger: SessionLogger;
  /** Clock seam — defaults to `new Date()`; tests inject a fixed clock. */
  now?: () => Date;
}

export interface WorkspaceTickResult {
  workspaceId: string;
  skipped?: "disabled" | "kill_switch";
  issues: Array<{ id: string; action: IssueAction }>;
  dispatches: Array<{ id: string; action: DispatchAction }>;
}

export class FlywheelEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: FlywheelEngineDeps) {}

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
   * Ingest one failure: fingerprint + dedup + REDACT before persist. New ⇒ insert; repeat ⇒ ++count;
   * a repeat of a *fixed* fingerprint ⇒ `markRecurred` (the #106 outcome verifier). Returns the row.
   */
  async record(event: FailureEvent): Promise<FingerprintRecord> {
    const now = this.clock();
    const { signature, title } = fingerprintFailure(event);
    const sample = buildSampleContext(event, (text) => this.deps.redact(text, event.secrets ?? {}));

    const existing = await this.deps.fingerprints.getBySignature(event.workspaceId, signature);
    if (!existing) {
      const row = await this.deps.fingerprints.insert({
        workspaceId: event.workspaceId,
        signature,
        failureClass: event.failureClass,
        title,
        sampleContext: sample,
        originChannelId: event.channelId ?? null,
        originAgentMemberId: event.agentMemberId ?? null,
        now,
      });
      recordFlywheelAction("ingest:new");
      return row;
    }

    let row = await this.deps.fingerprints.touch({ id: existing.id, now });
    // A failure we already marked fixed is back: the fix didn't hold — escalate + bar auto-dispatch.
    if (existing.status === "fixed") {
      row = await this.deps.fingerprints.markRecurred({ id: existing.id, now });
      recordFlywheelAction("ingest:recurred");
    } else {
      recordFlywheelAction("ingest:dedup");
    }
    return row;
  }

  /** Loop closure: a merged fix links its fingerprint (status `fixed`). */
  async markFixed(workspaceId: string, fingerprintId: string, fixRef: string): Promise<FingerprintRecord | null> {
    const fp = await this.deps.fingerprints.get(workspaceId, fingerprintId);
    if (!fp) return null;
    const row = await this.deps.fingerprints.markFixed({ id: fingerprintId, fixRef, now: this.clock() });
    recordFlywheelAction("fixed");
    return row;
  }

  /** One pass over every workspace with open fingerprints. */
  async tickAll(): Promise<void> {
    try {
      // #99: maintenance pauses the whole loop on the same Redis flag the HTTP write-gate reads — checked
      // BEFORE any DB call so a maintenance window stops all flywheel work immediately.
      if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) {
        this.deps.logger.warn({}, "flywheel tickAll skipped: maintenance mode active");
        return;
      }
      const now = this.clock();
      const workspaces = await this.deps.activeWorkspaces();
      for (const workspaceId of workspaces) {
        try {
          await this.tickWorkspace(workspaceId, now);
        } catch (err) {
          this.deps.logger.error({ err, workspaceId }, "flywheel tickAll: workspace tick failed");
        }
      }
    } catch (err) {
      recordLoopTickFailure("flywheel");
      this.deps.logger.error({ err }, "flywheel tickAll failed");
    }
  }

  /**
   * One pass over a single workspace: synthesize issues (rate-limited, ONE open per fingerprint) then
   * dispatch the top-ranked eligible fix (budget + concurrency + policy gated). The config flag and the
   * kill switch gate the whole pass first (mirrors the watchdog).
   */
  async tickWorkspace(workspaceId: string, now: Date): Promise<WorkspaceTickResult> {
    recordFlywheelTick();
    const log = this.deps.logger.child({ workspaceId, component: "flywheel" });
    const result: WorkspaceTickResult = { workspaceId, issues: [], dispatches: [] };

    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return { ...result, skipped: "disabled" };

    if (await this.deps.killSwitch(workspaceId)) {
      log.warn({}, "flywheel tick skipped: kill switch engaged");
      recordFlywheelAction("noop:kill_switch");
      return { ...result, skipped: "kill_switch" };
    }

    // --- (1) issue synthesis (rate-limited) -----------------------------------------------------
    const open = rankFingerprints(await this.deps.fingerprints.listOpen(workspaceId));
    let issued = 0;
    for (const fp of open) {
      const decision = decideIssueAction(fp, caps);
      if (decision.action === "draft" && !withinRateLimit(issued, caps.maxIssuesPerTick)) {
        recordFlywheelAction("issue:rate_limited");
        continue;
      }
      const applied = await this.applyIssueAction(fp, decision.action, now, log);
      if (applied) {
        result.issues.push({ id: fp.id, action: decision.action });
        if (decision.action === "draft") issued += 1;
      }
    }

    // --- (2) fix dispatch (top-ranked, triple-bounded) ------------------------------------------
    const budgetExhausted = await this.deps.budgetExhausted(workspaceId, now);
    const activeFixes = await this.deps.dispatches.countActive(workspaceId);
    // Re-read so freshly-drafted fingerprints (now with an issue_ref) are dispatch-eligible this tick.
    const dispatchable = rankFingerprints(await this.deps.fingerprints.listOpen(workspaceId)).filter(
      (fp) => fp.issueRef && fp.status !== "fixing",
    );
    let dispatched = 0;
    for (const fp of dispatchable) {
      if (dispatched >= caps.maxDispatchesPerTick) break;
      const autoAllowed = await this.deps.autoDispatchAllowed(workspaceId, fp.failureClass);
      const decision = decideDispatch({
        excludedFromAutoDispatch: fp.excludedFromAutoDispatch,
        autoAllowed,
        budgetExhausted,
        concurrencyAvailable: concurrencyAvailable(activeFixes + dispatched, caps.maxConcurrentFixes),
      });
      if (decision.action === "skip") {
        recordFlywheelAction(`dispatch:skip:${decision.reason}`);
        // Skip applies to the AUTO path only (budget/concurrency); keep scanning so a lower-ranked
        // fingerprint that would QUEUE for a human (excluded / policy-gated) still gets surfaced.
        continue;
      }
      await this.applyDispatch(workspaceId, fp, decision.action, decision.reason, now, log);
      result.dispatches.push({ id: fp.id, action: decision.action });
      dispatched += 1;
    }

    log.info({ issues: result.issues.length, dispatches: result.dispatches.length }, "flywheel tick complete");
    return result;
  }

  /** File / comment / reopen for one fingerprint. Returns true if a GitHub side effect was applied. */
  private async applyIssueAction(
    fp: FingerprintRecord,
    action: IssueAction,
    now: Date,
    log: SessionLogger,
  ): Promise<boolean> {
    try {
      if (action === "draft") {
        const { ref, state } = await this.deps.filer.create({
          workspaceId: fp.workspaceId,
          title: fp.title,
          body: renderIssueBody(fp),
          labels: ["flywheel", `flywheel:${fp.failureClass}`],
        });
        await this.deps.fingerprints.recordIssue({
          id: fp.id,
          issueRef: ref,
          issueState: state,
          status: "issued",
          syncedOccurrenceCount: fp.occurrenceCount,
          now,
        });
        recordFlywheelAction("issue:draft");
        return true;
      }
      if (action === "comment" && fp.issueRef) {
        await this.deps.filer.comment({
          workspaceId: fp.workspaceId,
          ref: fp.issueRef,
          body: renderRecurrenceComment(fp),
        });
        await this.deps.fingerprints.recordIssue({
          id: fp.id,
          issueRef: fp.issueRef,
          issueState: "open",
          status: "issued",
          syncedOccurrenceCount: fp.occurrenceCount,
          now,
        });
        recordFlywheelAction("issue:comment");
        return true;
      }
      if (action === "reopen" && fp.issueRef) {
        const { state } = await this.deps.filer.reopen({ workspaceId: fp.workspaceId, ref: fp.issueRef });
        await this.deps.filer.comment({
          workspaceId: fp.workspaceId,
          ref: fp.issueRef,
          body: renderReopenComment(fp),
        });
        await this.deps.fingerprints.recordIssue({
          id: fp.id,
          issueRef: fp.issueRef,
          issueState: state,
          status: "issued",
          syncedOccurrenceCount: fp.occurrenceCount,
          now,
        });
        recordFlywheelAction("issue:reopen");
        return true;
      }
    } catch (err) {
      // A GitHub failure never crashes the tick (best-effort, like the watchdog's channel post).
      log.error({ err, fingerprintId: fp.id, action }, "flywheel issue action failed");
    }
    return false;
  }

  /** Auto-launch a fix session OR enqueue a human approval, recording the durable dispatch row. */
  private async applyDispatch(
    workspaceId: string,
    fp: FingerprintRecord,
    action: "auto" | "queue",
    reason: string,
    now: Date,
    log: SessionLogger,
  ): Promise<void> {
    if (action === "auto") {
      const session = await this.deps.launcher.launch({
        workspaceId,
        fingerprint: fp,
        task: renderFixTask(fp),
        harnessEnv: { AGENT_FLYWHEEL_FIX: "1" },
      });
      await this.deps.dispatches.create({
        workspaceId,
        fingerprintId: fp.id,
        mode: "auto",
        status: "dispatched",
        sessionId: session.id,
        reason,
        now,
      });
      await this.deps.fingerprints.linkFix({ id: fp.id, fixSessionId: session.id, now });
      recordFlywheelAction("dispatch:auto");
      log.info({ fingerprintId: fp.id, sessionId: session.id }, "flywheel auto-dispatched a fix");
      return;
    }
    // queue for a human (sensitive-by-default class, or recurred-after-fix)
    const req = await this.deps.approvalQueue.enqueue({ workspaceId, fingerprint: fp, reason });
    await this.deps.dispatches.create({
      workspaceId,
      fingerprintId: fp.id,
      mode: "queued",
      status: "queued",
      approvalRequestId: req.id,
      reason,
      now,
    });
    recordFlywheelAction("dispatch:queue");
    log.info({ fingerprintId: fp.id, approvalRequestId: req.id, reason }, "flywheel queued a fix for approval");
  }
}

export { resolveFlywheelCaps };
