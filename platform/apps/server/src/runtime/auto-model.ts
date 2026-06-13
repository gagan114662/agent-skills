/**
 * Auto model-selection (convene-llm-gateway integration). When a session pins **no** explicit model,
 * this asks the routing layer for the best model for the task — **Claude is the orchestrator and the
 * line of control**: it validates worker output and escalates up to `claude-opus-4-8`. The chosen
 * model becomes the session's `ANTHROPIC_MODEL`; the routing decision (which model, why, validation
 * verdict, escalations, cost) is captured as the session's audit "why?" record.
 *
 * Precedence (enforced by the SessionManager that calls this): an explicit per-session selection (#52)
 * or a model already pinned in `harnessEnv` ALWAYS wins — auto only fills the gap where a launch would
 * otherwise use the deployment-default `ANTHROPIC_MODEL`.
 *
 * Safety invariants:
 *   - **Default OFF.** Enabled only when the deployment master switch (`RELOAD_AUTO_MODEL`) AND the
 *     gateway URL AND the per-tenant `autoModel.enabled` config are all on — so the owner workspace can
 *     be turned on first while every other tenant keeps today's behavior exactly.
 *   - **Never blocks a session.** Every failure path (disabled, gateway unreachable, a chosen model the
 *     tenant policy forbids) returns `undefined` ⇒ the caller falls back to the deployment default.
 *   - **Tenant-scoped + budget-respecting.** The workspace id is the gateway tenant (its keys/ceilings
 *     apply); the per-call cost ceiling is routed from the tenant's #71 budget / `maxCallCostCents`.
 *   - **Defense in depth.** The gateway's chosen model is re-validated against the #52 `models`
 *     allow-list via {@link resolveSelection}, so auto can never select outside what the tenant permits.
 *   - **Secret-free.** Only the routing decision (no prompt, no keys) is persisted.
 */
import type { ResolvedConfig } from "../config/schema.js";
import { windowKey, type UsageReader } from "../scale/usage.js";
import type { GatewayRoutingClient, GatewayRoutingDecision } from "./gateway-client.js";
import {
  modelPolicyFromConfig,
  resolveSelection,
  SelectionError,
  type ResolvedSelection,
} from "./model-selection.js";

/** The secret-free "why this model" record persisted to the session audit trail. */
export interface AutoModelDecision {
  /** The model auto-selection chose (the session's `ANTHROPIC_MODEL`). */
  chosenModel: string;
  /** Which stage decided: `heuristic` bypass vs the Claude `orchestrator`. */
  stage: string;
  /** Human-readable rationale from the orchestrator. */
  rationale: string;
  /** The validation verdict on the chosen model's output. */
  validationVerdict: string;
  /** Final quality confidence (0..1). */
  confidence: number;
  /** Every escalation hop the orchestrator took (worker → sonnet → opus). */
  escalations: GatewayRoutingDecision["escalations"];
  /** Estimated vs actual routing cost (cents). */
  estCostCents: number;
  actualCostCents: number;
  /** The gateway tenant (workspace id) + the cost ceiling routed through. */
  tenant: string;
  costCeilingCents?: number;
}

/** The outcome the SessionManager threads into the launch: env + selection metadata + the audit record. */
export interface AutoModelResult {
  /** Validated selection (env + provider/model/effort/mode) — built through the #52 policy. */
  selection: ResolvedSelection;
  /** The "why?" audit record persisted on the session row. */
  decision: AutoModelDecision;
}

export interface AutoModelInput {
  workspaceId: string;
  /** The session's task — the routing prompt the gateway profiles. */
  task: string;
}

export interface AutoModelDeps {
  /** The gateway routing seam (HTTP in prod, a fake in tests). */
  client: GatewayRoutingClient;
  /** Per-tenant config source (the layered #58 config). */
  loadConfig: (workspaceId: string) => ResolvedConfig;
  /** Deployment master switch (`RELOAD_AUTO_MODEL`). */
  enabled: boolean;
  /** Whether a gateway URL is configured (`LLM_GATEWAY_URL` present). */
  gatewayConfigured: boolean;
  /** Optional usage reader (#71): when present the cost ceiling is the tenant's REMAINING window budget. */
  usage?: UsageReader;
  /** Injectable clock for the window lookup (tests). */
  now?: () => Date;
}

export class AutoModelResolver {
  constructor(private readonly deps: AutoModelDeps) {}

  /** Whether auto model-selection is active for this tenant (all three gates on). Pure + cheap. */
  isEnabledFor(config: ResolvedConfig): boolean {
    return this.deps.enabled && this.deps.gatewayConfigured && config.autoModel?.enabled === true;
  }

  /**
   * Resolve the best model for a launch, or `undefined` to fall back to the deployment default.
   * Never throws — every error path degrades to `undefined` so a session is never blocked.
   */
  async resolve(input: AutoModelInput): Promise<AutoModelResult | undefined> {
    try {
      const config = this.deps.loadConfig(input.workspaceId);
      if (!this.isEnabledFor(config)) return undefined;

      const costCeilingCents = await this.deriveCostCeilingCents(input.workspaceId, config);

      const decision = await this.deps.client.route({
        prompt: input.task,
        tenant: input.workspaceId,
        costCeilingCents,
      });
      // Gateway disabled/unreachable, or it could not produce an accepted answer ⇒ fall back.
      if (!decision || !decision.ok || !decision.chosen) return undefined;

      // Defense in depth: re-validate the chosen model against the tenant's #52 allow-list and build
      // the secret-free env. A model the tenant forbids (or a malformed id) throws → fall back.
      let selection: ResolvedSelection;
      try {
        selection = resolveSelection({ model: decision.chosen }, modelPolicyFromConfig(config));
      } catch (err) {
        if (err instanceof SelectionError) return undefined;
        throw err;
      }

      return {
        selection,
        decision: {
          chosenModel: decision.chosen,
          stage: decision.stage,
          rationale: decision.rationale,
          validationVerdict: decision.validationVerdict,
          confidence: decision.confidence,
          escalations: decision.escalations,
          estCostCents: decision.estCostCents,
          actualCostCents: decision.actualCostCents,
          tenant: input.workspaceId,
          costCeilingCents,
        },
      };
    } catch {
      // Any unexpected error must never block a session.
      return undefined;
    }
  }

  /**
   * Route the existing per-tenant budget cap (#71) through to the gateway as a per-call ceiling.
   *   - `autoModel.maxCallCostCents > 0` pins it explicitly.
   *   - else with a tenant budget set: the REMAINING window budget (`budgetCents` − accrued) when a
   *     usage reader is wired, else the full configured `budgetCents`.
   *   - else (no budget) `undefined` ⇒ the gateway applies its own per-tenant default ceiling.
   * The hard budget enforcement still happens at #71 admission; this is the soft per-call routing cap.
   */
  private async deriveCostCeilingCents(
    workspaceId: string,
    config: ResolvedConfig,
  ): Promise<number | undefined> {
    const knob = config.autoModel?.maxCallCostCents ?? 0;
    if (knob > 0) return knob;

    const budgetCents = config.scale?.budgetCents ?? 0;
    if (budgetCents <= 0) return undefined;
    if (!this.deps.usage) return budgetCents;

    try {
      const now = this.deps.now?.() ?? new Date();
      const snapshot = await this.deps.usage.read(workspaceId, windowKey(now));
      const remaining = budgetCents - (snapshot?.estimatedCostCents ?? 0);
      // Keep at least 1¢ so the gateway can still pick the cheapest model; admission enforces the
      // real cap (a launch is denied once accrued cost meets the budget).
      return remaining > 0 ? remaining : 1;
    } catch {
      // A usage-read hiccup must not block routing — fall back to the full configured budget.
      return budgetCents;
    }
  }
}
