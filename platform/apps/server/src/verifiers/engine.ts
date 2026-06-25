import type { SessionLogger } from "../runtime/manager.js";
import { recordVerifierAction, recordVerifierTick } from "../observability/metrics.js";
import { resolveVerifierCaps, type VerifierCaps } from "./caps.js";
import { decideVerification } from "./decide.js";
import { evaluateClaim } from "./registry.js";
import {
  isObservationError,
  type Observation,
  type ObservationError,
  type VerifierClaim,
  type VerifierOutcome,
  type VerifierResultRecord,
  type VerifierStatus,
} from "./types.js";

/**
 * VerifierRunner (#106, ADR-0106) — the IO orchestrator for Outcome Verifiers. `verify()` measures one
 * claim (through the observation seam), judges it through the pure {@link evaluateClaim} registry, writes
 * the verdict as a durable evidence row, and on a measured FAILURE opens a #13 escalation (stamping its
 * request id onto the row) — a failed gate never silently passes. `tickWorkspace`/`tickAll` sweep the
 * due claims on infrastructure time.
 *
 * The decision is pure (`decide.ts` / `registry.ts`); every side effect (measure, redact+persist,
 * escalate) is a seam here. Gating mirrors the other loops: maintenance (#99) before any DB call, then
 * per-workspace the config `enabled` flag and the #17 kill switch.
 */

// ---- seams -------------------------------------------------------------------------------------

/** Measures a claim. Returns a measured {@link Observation} or an {@link ObservationError} (un-measurable). */
export interface ObservationSource {
  observe(claim: VerifierClaim): Promise<Observation | ObservationError>;
}

/** The durable evidence store (real impl wraps the `verifier_results` repo; tests fake it). */
export interface VerifierResultStore {
  record(input: {
    workspaceId: string;
    kind: VerifierClaim["kind"];
    claimRef: string;
    status: VerifierStatus;
    measuredValue: number;
    threshold: number;
    detail: string;
    escalationRequestId?: string | null;
    source?: string | null;
    now: Date;
  }): Promise<VerifierResultRecord>;
}

/** The #13 escalation seam — enqueue a human approval for a FAILED verification. */
export interface VerifierEscalator {
  escalate(input: {
    workspaceId: string;
    claim: VerifierClaim;
    outcome: VerifierOutcome;
  }): Promise<{ id: string }>;
}

/** The due-claim work-list for a workspace's tick (real impl reads pending verifications). */
export interface VerifierClaimSource {
  listDue(workspaceId: string): Promise<VerifierClaim[]>;
}

/** Optional learning-loop hook: a passed verifier outcome can distill a cross-venture playbook. */
export interface VerifiedWinRecorder {
  record(input: {
    claim: VerifierClaim;
    outcome: VerifierOutcome;
    record: VerifierResultRecord;
  }): Promise<void>;
}

export interface VerifierRunnerDeps {
  observations: ObservationSource;
  results: VerifierResultStore;
  escalator: VerifierEscalator;
  claims: VerifierClaimSource;
  /** Resolve the per-workspace verifier caps (config; default OFF). */
  caps: (workspaceId: string) => VerifierCaps;
  /** The #17 kill switch for a workspace (halts its tick). */
  killSwitch: (workspaceId: string) => Promise<boolean>;
  /** Workspaces with due verifications (the tick work-list). */
  activeWorkspaces: () => Promise<string[]>;
  /** Redact a string before it is persisted into the evidence detail (#25). */
  redact: (text: string) => string;
  /** Optional maintenance-pause check (#99) — when true, `tickAll()` skips BEFORE any DB call. */
  maintenancePaused?: () => Promise<boolean>;
  /** Optional #888 learning loop. Best-effort; never changes the verifier verdict. */
  playbooks?: VerifiedWinRecorder;
  logger: SessionLogger;
  /** Clock seam — defaults to `new Date()`; tests inject a fixed clock. */
  now?: () => Date;
}

/** The verdict of one `verify()` (returned for tests + the tick roll-up). */
export interface VerifyResult {
  record: VerifierResultRecord;
  action: "record_pass" | "escalate" | "skip";
}

export interface WorkspaceVerifyResult {
  workspaceId: string;
  skipped?: "disabled" | "kill_switch";
  verified: VerifyResult[];
}

export class VerifierRunner {
  constructor(private readonly deps: VerifierRunnerDeps) {}

  private clock(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Verify ONE claim now: measure → judge (pure) → persist the durable verdict → escalate on a measured
   * failure. The atomic unit the tick and any call-site reuse. Returns the persisted row + the action.
   */
  async verify(claim: VerifierClaim): Promise<VerifyResult> {
    const now = this.clock();
    const caps = this.deps.caps(claim.workspaceId);

    const measured = await this.measure(claim);
    const outcome: VerifierOutcome | { errored: true } = isObservationError(measured)
      ? { errored: true }
      : evaluateClaim(claim, measured);

    const decision = decideVerification(outcome, caps);
    const detail = isObservationError(measured)
      ? `unmeasurable: ${measured.reason}`
      : (outcome as VerifierOutcome).detail;
    const measuredValue = isObservationError(measured)
      ? 0
      : (outcome as VerifierOutcome).measuredValue;
    const threshold = isObservationError(measured)
      ? claim.target
      : (outcome as VerifierOutcome).threshold;

    // Escalate FIRST (when decided) so the durable row carries the #13 request id — a failed gate is
    // never written without its escalation linkage. An escalation that cannot be enqueued is logged and
    // the row still persists `failed` (the verdict is never lost).
    let escalationRequestId: string | null = null;
    if (decision.action === "escalate") {
      escalationRequestId = await this.tryEscalate(claim, outcome as VerifierOutcome);
    }

    const record = await this.deps.results.record({
      workspaceId: claim.workspaceId,
      kind: claim.kind,
      claimRef: claim.claimRef,
      status: decision.status,
      measuredValue,
      threshold,
      detail: this.deps.redact(detail),
      escalationRequestId,
      source: claim.source ?? null,
      now,
    });

    recordVerifierAction(`${claim.kind}:${decision.status}`);
    if (decision.action === "escalate") recordVerifierAction("escalate");
    if (decision.action === "record_pass" && !isObservationError(measured)) {
      await this.recordVerifiedWin(claim, outcome as VerifierOutcome, record);
    }
    return { record, action: decision.action };
  }

  private async recordVerifiedWin(
    claim: VerifierClaim,
    outcome: VerifierOutcome,
    record: VerifierResultRecord,
  ): Promise<void> {
    if (!this.deps.playbooks) return;
    try {
      await this.deps.playbooks.record({ claim, outcome, record });
    } catch (err) {
      this.deps.logger.warn(
        { err, claimRef: claim.claimRef },
        "verifier playbook distillation failed",
      );
    }
  }

  /** One pass over every workspace with due verifications. */
  async tickAll(): Promise<void> {
    // #99: maintenance pauses the whole loop on the same Redis flag the HTTP write-gate reads — checked
    // BEFORE any DB call so a maintenance window stops all verifier work immediately.
    if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) {
      this.deps.logger.warn({}, "verifier tickAll skipped: maintenance mode active");
      return;
    }
    const workspaces = await this.deps.activeWorkspaces();
    for (const workspaceId of workspaces) {
      try {
        await this.tickWorkspace(workspaceId);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "verifier tickAll: workspace tick failed");
      }
    }
  }

  /**
   * One pass over a single workspace's due claims (bounded by `maxPerTick`). The config flag and the
   * kill switch gate the whole pass first (mirrors the SRE/flywheel loops). Returns a result for tests.
   */
  async tickWorkspace(workspaceId: string): Promise<WorkspaceVerifyResult> {
    recordVerifierTick();
    const log = this.deps.logger.child({ workspaceId, component: "verifiers" });

    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return { workspaceId, skipped: "disabled", verified: [] };

    if (await this.deps.killSwitch(workspaceId)) {
      log.warn({}, "verifier tick skipped: kill switch engaged");
      recordVerifierAction("noop:kill_switch");
      return { workspaceId, skipped: "kill_switch", verified: [] };
    }

    const due = (await this.deps.claims.listDue(workspaceId)).slice(0, caps.maxPerTick);
    const verified: VerifyResult[] = [];
    for (const claim of due) {
      try {
        verified.push(await this.verify(claim));
      } catch (err) {
        log.error({ err, kind: claim.kind, claimRef: claim.claimRef }, "verifier verify failed");
      }
    }

    log.info(
      {
        verified: verified.length,
        escalated: verified.filter((v) => v.action === "escalate").length,
      },
      "verifier tick complete",
    );
    return { workspaceId, verified };
  }

  /** Measure a claim; a probe that THROWS is folded into an `errored` observation (never a false fail). */
  private async measure(claim: VerifierClaim): Promise<Observation | ObservationError> {
    try {
      return await this.deps.observations.observe(claim);
    } catch (err) {
      this.deps.logger.error(
        { err, kind: claim.kind, claimRef: claim.claimRef },
        "verifier observe threw",
      );
      return {
        kind: claim.kind,
        errored: true,
        reason: err instanceof Error ? err.message : "observe failed",
      };
    }
  }

  /** Enqueue the #13 escalation for a failed verification; best-effort — a failure is logged, not thrown. */
  private async tryEscalate(
    claim: VerifierClaim,
    outcome: VerifierOutcome,
  ): Promise<string | null> {
    try {
      const { id } = await this.deps.escalator.escalate({
        workspaceId: claim.workspaceId,
        claim,
        outcome,
      });
      return id;
    } catch (err) {
      this.deps.logger.error(
        { err, kind: claim.kind, claimRef: claim.claimRef },
        "verifier escalation failed; row persists as failed",
      );
      return null;
    }
  }
}

export { resolveVerifierCaps };
