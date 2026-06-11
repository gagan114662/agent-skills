import {
  decideGatePricing,
  summarizeWindow,
  type GatePricingDecision,
  type Outcome,
} from "./pricing.js";
import { isInvariantAction } from "./invariants.js";
import { gatePricingThresholds, type GatePricingCaps } from "./caps.js";

/**
 * The Evidence-Priced Autonomy IO orchestrator (#119, ADR-0119). For each action class with recorded
 * evidence it reads the trailing window, asks the pure {@link decideGatePricing} whether the boundary
 * should move, and — on a non-HOLD recommendation — toggles the #95 `approval_policies` rule and writes
 * the `gate_boundary_changes` audit row. No gating logic lives here; the decision is pure. Every seam is
 * injectable, so the service runs against fakes in unit tests and the real repos in `default.ts`.
 *
 * **Default-OFF**: `caps(workspaceId).enabled` short-circuits the whole tick, so wiring it changes
 * nothing until a deployment opts in (mirrors #96 venture / #105 watchdog).
 */

/** A boundary change the tick applied (for logging / the return value). */
export interface AppliedChange {
  actionType: string;
  decision: GatePricingDecision;
}

export interface GatePricingDeps {
  /** Resolved policy for the workspace (the `enabled` flag + window + rails). */
  caps: (workspaceId: string) => GatePricingCaps;
  /** Distinct action classes that have recorded evidence — the work-list. */
  listActionTypes: (workspaceId: string) => Promise<string[]>;
  /** The last `limit` outcomes for an action class, newest-first. */
  readWindow: (workspaceId: string, actionType: string, limit: number) => Promise<Outcome[]>;
  /** Whether a #95 auto-approve rule currently exists for the class, and its id (for revocation). */
  currentlyRelaxed: (
    workspaceId: string,
    actionType: string,
  ) => Promise<{ relaxed: boolean; ruleId: string | null }>;
  /** Create a #95 auto-approve rule (`require_approval = false`); returns the new rule id. */
  relax: (workspaceId: string, actionType: string) => Promise<string>;
  /** Revoke a #95 auto-approve rule by id. */
  retighten: (workspaceId: string, ruleId: string) => Promise<void>;
  /** Append the boundary-change audit row. */
  audit: (change: {
    workspaceId: string;
    actionType: string;
    direction: "RELAX" | "RETIGHTEN";
    errorRate: number;
    windowSize: number;
    policyRuleId: string | null;
    reason: string;
  }) => Promise<void>;
  logger?: { info?: (o: unknown, m?: string) => void; error?: (o: unknown, m?: string) => void };
}

export class GatePricingService {
  private readonly deps: GatePricingDeps;

  constructor(deps: GatePricingDeps) {
    this.deps = deps;
  }

  /**
   * Re-price every action class with evidence for one workspace. Returns the changes applied (empty
   * when disabled or when every class HOLDs). Side effects: policy upsert/delete + an audit row per
   * change. A per-class error is logged and skipped so one bad class never aborts the pass.
   */
  async tick(workspaceId: string): Promise<AppliedChange[]> {
    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return [];
    const thresholds = gatePricingThresholds(caps);

    const actionTypes = await this.deps.listActionTypes(workspaceId);
    const applied: AppliedChange[] = [];

    for (const actionType of actionTypes) {
      try {
        const outcomes = await this.deps.readWindow(workspaceId, actionType, caps.windowSize);
        const { relaxed, ruleId } = await this.deps.currentlyRelaxed(workspaceId, actionType);
        const decision = decideGatePricing({
          actionType,
          window: summarizeWindow(outcomes),
          currentlyRelaxed: relaxed,
          thresholds,
        });

        if (decision.recommendation === "RELAX") {
          // Belt-and-suspenders: the type system already forbids a RELAX for an invariant (the
          // decision carries a RelaxableActionType), but assert it here too before any mutation.
          if (isInvariantAction(actionType)) continue;
          const newRuleId = await this.deps.relax(workspaceId, decision.action);
          await this.deps.audit({
            workspaceId,
            actionType,
            direction: "RELAX",
            errorRate: decision.errorRate,
            windowSize: decision.windowSize,
            policyRuleId: newRuleId,
            reason: decision.reason,
          });
          applied.push({ actionType, decision });
        } else if (decision.recommendation === "RETIGHTEN") {
          // Only act if a rule actually exists to revoke (an invariant flagged for re-tighten with no
          // rule is already strict — nothing to do).
          if (relaxed && ruleId) {
            await this.deps.retighten(workspaceId, ruleId);
            await this.deps.audit({
              workspaceId,
              actionType,
              direction: "RETIGHTEN",
              errorRate: decision.errorRate,
              windowSize: decision.windowSize,
              policyRuleId: ruleId,
              reason: decision.reason,
            });
            applied.push({ actionType, decision });
          }
        }
        // HOLD → no side effect.
      } catch (err) {
        this.deps.logger?.error?.({ err, workspaceId, actionType }, "gate-pricing tick failed");
      }
    }
    return applied;
  }
}
