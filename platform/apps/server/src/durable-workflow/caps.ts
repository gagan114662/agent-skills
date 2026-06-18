/**
 * Durable-workflow policy resolution (#338, ADR-0338) — mirrors `skillopt/caps.ts` / `venture/caps.ts`.
 * The durable path is a new way to run a long wait, so it ships **default OFF**, owner-workspace-first
 * (premortem #200 §4 + the issue's "default OFF behind a flag, owner workspace first"): a deployment that
 * sets no `durableWorkflow` block keeps the legacy in-process poll byte-for-byte. Even when `enabled`, an
 * `ownerWorkspaceOnly` deployment (the default) only routes the owner's own workspace through the durable
 * engine; every other tenant is untouched. The numeric knobs bound the retry schedule + the wall-clock
 * deadline (the no-hang budget). Pure ⇒ unit-testable.
 */
import type { DurableWorkflowConfig } from "../config/schema.js";
import type { BackoffPolicy } from "./types.js";

export interface DurableWorkflowCaps {
  /** Master flag for routing long waits through the durable engine. OFF by default. */
  enabled: boolean;
  /**
   * Roll out owner-workspace-first (the default): when true, only `ownerWorkspaceId` uses the durable path
   * even if `enabled`; every other tenant keeps the legacy in-process poll. Set false to enable for all.
   */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the durable path dogfoods here first. */
  ownerWorkspaceId: string | undefined;
  /** Hard cap on attempts per step (bounded retries — never retry forever). */
  maxAttempts: number;
  /** First backoff delay (ms); doubles each attempt up to `backoffCapMs`. */
  backoffBaseMs: number;
  /** Backoff ceiling (ms). */
  backoffCapMs: number;
  /** Default wall-clock budget (ms) for a run with no explicit timeout (the no-hang deadline). */
  defaultTimeoutMs: number;
}

export const DURABLE_WORKFLOW_DEFAULTS: DurableWorkflowCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: undefined,
  maxAttempts: 40,
  backoffBaseMs: 3_000,
  backoffCapMs: 15_000,
  defaultTimeoutMs: 120_000,
};

export function resolveDurableWorkflowCaps(
  cfg: DurableWorkflowConfig | undefined,
): DurableWorkflowCaps {
  return {
    enabled: cfg?.enabled ?? DURABLE_WORKFLOW_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? DURABLE_WORKFLOW_DEFAULTS.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? DURABLE_WORKFLOW_DEFAULTS.ownerWorkspaceId,
    maxAttempts: cfg?.maxAttempts ?? DURABLE_WORKFLOW_DEFAULTS.maxAttempts,
    backoffBaseMs: cfg?.backoffBaseMs ?? DURABLE_WORKFLOW_DEFAULTS.backoffBaseMs,
    backoffCapMs: cfg?.backoffCapMs ?? DURABLE_WORKFLOW_DEFAULTS.backoffCapMs,
    defaultTimeoutMs: cfg?.defaultTimeoutMs ?? DURABLE_WORKFLOW_DEFAULTS.defaultTimeoutMs,
  };
}

/** The bounded retry schedule the runner uses, derived from caps. */
export function backoffPolicyFromCaps(caps: DurableWorkflowCaps): BackoffPolicy {
  return {
    baseMs: caps.backoffBaseMs,
    factor: 2,
    capMs: caps.backoffCapMs,
    maxAttempts: caps.maxAttempts,
  };
}

/**
 * Pure: is the durable path ENABLED for this specific workspace? Default OFF, owner-workspace-first — even
 * when the master `enabled` flag is on, an `ownerWorkspaceOnly` deployment (the default) only routes the
 * named owner workspace; turning `enabled` on WITHOUT naming the owner routes nobody (the safest default,
 * matching `skillopt`/`venture`/`delivery`). Set `ownerWorkspaceOnly` false to enable for all tenants.
 */
export function isDurableWorkflowEnabledForWorkspace(
  caps: DurableWorkflowCaps,
  workspaceId: string,
): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== undefined && caps.ownerWorkspaceId === workspaceId;
}
