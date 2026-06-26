import type { BootstrapPlan, BootstrapStep, BootstrapStepKind, MoneyClass } from "./types.js";
import type { ReversibilityClass } from "../verification/types.js";

/**
 * Venture bootstrap planning + the MONEY boundary (#187 AC3 + AC4, #1055). **Pure** — given an approved
 * candidate it produces the ordered, **idempotent** list of steps that stand up the whole venture, and
 * classifies which steps spend money / cross an irreversible boundary (premortem #200 FM#4).
 *
 * AC3: one approved `venture.bootstrap` decision spins up everything — workspace, brand kit, landing,
 * repo/deploy target (if software), budget caps, and the seven-department fleet (idempotent, like the
 * #138 seeding: every step carries an `idempotencyKey`, so a re-run is a no-op).
 *
 * AC4/#1055: domain purchase and ad-spend start are MONEY decisions that may run autonomously only after
 * the service reserves their estimated spend inside the hard budget cap. Raising that cap is the owner
 * decision (#13/#170). Everything else proceeds without a human.
 */

/** The bootstrap steps that spend money / attach a payment method → must fit inside the hard cap. */
const MONEY_STEPS: ReadonlySet<BootstrapStepKind> = new Set<BootstrapStepKind>([
  "domain_purchase",
  "ad_spend_start",
  "payment_method",
]);

/** Conservative bootstrap cost estimates. Cap raises, not individual actions, are human-gated (#1055). */
export const BOOTSTRAP_STEP_ESTIMATED_COST_CENTS: Record<BootstrapStepKind, number> = {
  provision_workspace: 0,
  brand_kit: 0,
  landing_page: 0,
  repo_deploy_target: 0,
  budget_caps: 0,
  seed_fleet: 0,
  domain_purchase: 1_500,
  ad_spend_start: 0,
  payment_method: 0,
};

/** The reversibility class of each step (FM#4): money/domain are irreversible; the rest are reversible. */
const STEP_REVERSIBILITY: Record<BootstrapStepKind, ReversibilityClass> = {
  provision_workspace: "reversible",
  brand_kit: "reversible",
  landing_page: "reversible",
  repo_deploy_target: "reversible",
  budget_caps: "reversible",
  seed_fleet: "reversible",
  domain_purchase: "irreversible",
  ad_spend_start: "irreversible",
  payment_method: "irreversible",
};

/** Classify a step's money boundary. Pure — `money` ⇒ owner #13 decision, `autonomous` ⇒ just run it. */
export function classifyMoneyBoundary(kind: BootstrapStepKind): MoneyClass {
  return MONEY_STEPS.has(kind) ? "money" : "autonomous";
}

function step(
  kind: BootstrapStepKind,
  candidateId: string,
  summary: string,
  estimatedCostCents = BOOTSTRAP_STEP_ESTIMATED_COST_CENTS[kind],
): BootstrapStep {
  return {
    kind,
    // idempotency key is stable per (candidate, step) so a re-run never double-provisions (#138 discipline).
    idempotencyKey: `${candidateId}:${kind}`,
    money: classifyMoneyBoundary(kind),
    estimatedCostCents,
    reversibility: STEP_REVERSIBILITY[kind],
    summary,
  };
}

export interface PlanBootstrapInput {
  candidateId: string;
  ventureName: string;
  /** True when the product is software (adds a repo + deploy target). */
  software: boolean;
  /** Whether to include a paid-acquisition step (default false → no ad spend reserved). */
  includeAdSpend?: boolean;
  /** Budget to reserve for the first paid-acquisition pass. */
  adSpendBudgetCents?: number;
}

/**
 * Build the idempotent bootstrap plan. The autonomous, reversible steps come first (they just run on
 * approval); the irreversible MONEY steps come last (each is cap-reserved before it runs). The order is
 * deterministic so a re-plan is byte-identical and the idempotency keys line up.
 */
export function planBootstrap(input: PlanBootstrapInput): BootstrapPlan {
  const id = input.candidateId;
  const steps: BootstrapStep[] = [
    step("provision_workspace", id, `provision tenant workspace for ${input.ventureName}`),
    step("brand_kit", id, `generate the brand mark + kit for ${input.ventureName}`),
    step("landing_page", id, `publish the landing page for ${input.ventureName}`),
  ];
  if (input.software) {
    steps.push(step("repo_deploy_target", id, `create the repo + deploy target for ${input.ventureName}`));
  }
  steps.push(step("budget_caps", id, `apply the #71 budget caps for ${input.ventureName}`));
  steps.push(step("seed_fleet", id, `seed the seven-department fleet for ${input.ventureName}`));

  // ── irreversible MONEY steps last — each must reserve inside the hard cap before it runs ──
  steps.push(step("domain_purchase", id, `register the domain for ${input.ventureName}`));
  steps.push(step("payment_method", id, `attach a payment method for ${input.ventureName}`));
  if (input.includeAdSpend) {
    steps.push(
      step(
        "ad_spend_start",
        id,
        `start paid acquisition for ${input.ventureName}`,
        Math.max(0, Math.round(input.adSpendBudgetCents ?? 0)),
      ),
    );
  }

  return { candidateId: id, software: input.software, steps };
}

/** The reversible, autonomous steps (run on approval, no extra human gate). */
export function autonomousSteps(plan: BootstrapPlan): BootstrapStep[] {
  return plan.steps.filter((s) => s.money === "autonomous");
}

/** The MONEY steps (each must reserve spend inside the hard cap before it runs). */
export function moneySteps(plan: BootstrapPlan): BootstrapStep[] {
  return plan.steps.filter((s) => s.money === "money");
}
