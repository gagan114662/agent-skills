import type { BootstrapPlan, BootstrapStep, BootstrapStepKind, MoneyClass } from "./types.js";
import type { ReversibilityClass } from "../verification/types.js";

/**
 * Venture bootstrap planning + the MONEY boundary (#187 AC3 + AC4). **Pure** — given an approved
 * candidate it produces the ordered, **idempotent** list of steps that stand up the whole venture, and
 * classifies which steps spend money / cross an irreversible boundary (premortem #200 FM#4).
 *
 * AC3: one approved `venture.bootstrap` decision spins up everything — workspace, brand kit, landing,
 * repo/deploy target (if software), budget caps, and the seven-department fleet (idempotent, like the
 * #138 seeding: every step carries an `idempotencyKey`, so a re-run is a no-op).
 *
 * AC4: domain purchase, ad-spend start, and payment-method use are MONEY decisions that queue for the
 * owner (#13/#170). Everything else proceeds without a human. The classifier here is the single source
 * of truth for that boundary, so the service can route money steps to the gate and run the rest.
 */

/** The bootstrap steps that spend money / attach a payment method → always an owner #13 decision. */
const MONEY_STEPS: ReadonlySet<BootstrapStepKind> = new Set<BootstrapStepKind>([
  "domain_purchase",
  "ad_spend_start",
  "payment_method",
]);

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

function step(kind: BootstrapStepKind, candidateId: string, summary: string): BootstrapStep {
  return {
    kind,
    // idempotency key is stable per (candidate, step) so a re-run never double-provisions (#138 discipline).
    idempotencyKey: `${candidateId}:${kind}`,
    money: classifyMoneyBoundary(kind),
    reversibility: STEP_REVERSIBILITY[kind],
    summary,
  };
}

export interface PlanBootstrapInput {
  candidateId: string;
  ventureName: string;
  /** True when the product is software (adds a repo + deploy target). */
  software: boolean;
  /** Whether to include a paid-acquisition step (default false → no ad spend queued). */
  includeAdSpend?: boolean;
}

/**
 * Build the idempotent bootstrap plan. The autonomous, reversible steps come first (they just run on
 * approval); the irreversible MONEY steps come last (each parks as its own owner decision). The order is
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

  // ── irreversible MONEY steps last — each queues for the owner (#13/#170), never auto-run ──
  steps.push(step("domain_purchase", id, `register the domain for ${input.ventureName}`));
  steps.push(step("payment_method", id, `attach a payment method for ${input.ventureName}`));
  if (input.includeAdSpend) {
    steps.push(step("ad_spend_start", id, `start paid acquisition for ${input.ventureName}`));
  }

  return { candidateId: id, software: input.software, steps };
}

/** The reversible, autonomous steps (run on approval, no extra human gate). */
export function autonomousSteps(plan: BootstrapPlan): BootstrapStep[] {
  return plan.steps.filter((s) => s.money === "autonomous");
}

/** The MONEY steps (each queues as its own owner #13 decision). */
export function moneySteps(plan: BootstrapPlan): BootstrapStep[] {
  return plan.steps.filter((s) => s.money === "money");
}
