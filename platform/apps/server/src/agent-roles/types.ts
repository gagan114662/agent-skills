/**
 * Agent role registry + task-routing types (issue #586).
 *
 * Today agent responsibilities are *implicit*: the orchestrator spawns generic agents and hopes each one
 * picks up the right slice of work, so mandates overlap, two agents redo the same task, and nobody owns a
 * gap. This module makes the role a **first-class, declared thing**: each role states its mandate (what it
 * is responsible for), the tools it is *allowed* to use (a scoped toolset, not "every tool"), and the
 * outputs it is expected to produce. The orchestrator then **routes a task to a role** — by an explicit
 * task kind and/or the task text — instead of spawning an undifferentiated agent.
 *
 * Everything here is plain data and the routing is a pure function (see `route.ts`); there is no clock, no
 * IO, and no global state — a routing decision is reproducible in a unit test from its inputs alone.
 *
 * Self-contained on purpose (the #635/#670/#674 convention): the canonical roster lives in `roles.ts` and
 * the registry is constructed in-process (`registry.ts`), so the #586 change set touches no migration, no
 * schema barrel, and no app-wiring registry — it never collides with a sibling branch. Wiring the registry
 * into the orchestrator's spawn path is a one-liner left to the integrator.
 */

/** The five canonical agent roles in the marketing/ops fleet. */
export const ROLE_IDS = ["scout", "strategist", "writer", "distributor", "analyst"] as const;

/** A role identifier — one of {@link ROLE_IDS}. */
export type AgentRole = (typeof ROLE_IDS)[number];

/**
 * The kind of work a task represents. Routing prefers an *explicit* kind when the caller supplies one; each
 * role declares the kinds it owns (see {@link RoleDefinition.handlesTaskKinds}), so a kind-tagged task is a
 * strong, unambiguous routing signal that does not depend on parsing free text.
 *   - `research`     — find prospects, signals, intel (scout)
 *   - `strategy`     — decide approach, segment, sequence, prioritize (strategist)
 *   - `drafting`     — produce copy / creative / assets (writer)
 *   - `distribution` — send, publish, schedule across channels (distributor)
 *   - `analysis`     — measure results, attribute outcomes, report (analyst)
 */
export const TASK_KINDS = ["research", "strategy", "drafting", "distribution", "analysis"] as const;

/** A task kind — one of {@link TASK_KINDS}. */
export type TaskKind = (typeof TASK_KINDS)[number];

/**
 * A first-class role: its mandate, its scoped toolset, the outputs it owns, and the routing signals that
 * pull work toward it. Pure declarative data — the registry (`registry.ts`) indexes these and the router
 * (`route.ts`) scores against them.
 */
export interface RoleDefinition {
  /** Stable role id (the key everything routes on). */
  id: AgentRole;
  /** Human-facing label, e.g. "Scout". */
  title: string;
  /** One sentence: what this role is responsible for (and, by omission, what it is not). */
  mandate: string;
  /**
   * The tools this role is *allowed* to use — a scoped toolset, not a grant of everything. A task that
   * requires a tool outside this set will not route here (see `route.ts`), which is how the registry keeps
   * each running agent on a least-privilege toolset (the acceptance criterion).
   */
  allowedTools: readonly string[];
  /** The artifacts this role is expected to hand off (its deliverables). */
  outputs: readonly string[];
  /** The task kinds this role owns. A kind-tagged task routes to the role(s) that list it. */
  handlesTaskKinds: readonly TaskKind[];
  /**
   * Lowercase keywords that pull free-text work toward this role when no explicit kind is given. Matched
   * as whole words against the task text; every match is recorded in the decision so routing is explainable
   * (the #611 lead-scoring "show your factors" convention), never a black box.
   */
  keywords: readonly string[];
}

/**
 * A unit of work to route. Everything except `description` is optional: a caller that knows the kind should
 * pass it (the strongest signal); a caller that needs specific tools passes `requiredTools` so the router
 * can exclude roles that are not allowed to use them.
 */
export interface RoutingTask {
  /** Free-text description of the work (used for keyword routing when `kind` is absent or ambiguous). */
  description: string;
  /** An explicit task kind, if the caller knows it — the strongest routing signal. */
  kind?: TaskKind;
  /**
   * Tools the task is known to require. A role that does not allow *all* of these is disqualified, so a
   * task that needs a tool outside a role's scope never routes there. Empty/omitted ⇒ no tool constraint.
   */
  requiredTools?: readonly string[];
}

/** How strong a routing decision is — derived from the winner's score and its margin over the runner-up. */
export type RoutingConfidence = "high" | "medium" | "low" | "none";

/** One role's score in a routing decision, with the human-readable reasons that produced it. */
export interface RoleScore {
  role: AgentRole;
  /** Total points this role accrued for the task (higher = better fit). */
  score: number;
  /** Whether the role survived the `requiredTools` capability filter. A disqualified role scores 0. */
  eligible: boolean;
  /** Plain-language reasons (kind match, matched keywords, disqualification) — the explainability trail. */
  reasons: string[];
  /** The role's keywords that matched the task text (subset of {@link RoleDefinition.keywords}). */
  matchedKeywords: string[];
}

/**
 * The result of routing a task. `role` is the chosen role, or `null` when no role showed any positive
 * signal (an honest "needs a human / clarification" rather than a silent mis-route). `ranked` lists every
 * role best-first so a caller can see the alternatives and the margin.
 */
export interface RoutingDecision {
  /** The role the task should be handed to, or `null` when nothing matched. */
  role: AgentRole | null;
  /** Confidence in the choice (`none` when `role` is `null`). */
  confidence: RoutingConfidence;
  /** Every candidate role scored, sorted by score desc then {@link ROLE_IDS} order (deterministic). */
  ranked: RoleScore[];
  /** A single user-facing sentence explaining the routing outcome. */
  rationale: string;
}
