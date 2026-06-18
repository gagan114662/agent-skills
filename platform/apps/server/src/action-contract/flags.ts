/**
 * The action-contract feature flags (issue #337, ADR-0337). Every irreversible capability is OFF by
 * default behind a feature flag, owner-workspace-first (#200 §4/§5) — a deployment that sets nothing keeps
 * today's behavior: no contract APPLY runs, and an irreversible apply is impossible. Mirrors the
 * `delivery`/`skillopt` resolver exactly (default-OFF, owner-workspace-first).
 *
 * Pure + dependency-free.
 */

import type { ReversibilityClass } from "./contract.js";

/** The flags that decide whether a contract may APPLY a change for a workspace. */
export interface ActionContractFlags {
  /** Master switch — when false the contract is inert: nothing applies, today's behavior. Default OFF. */
  enabled: boolean;
  /**
   * Whether IRREVERSIBLE capabilities may apply (deploy cutovers, brand/legal/money surfaces). Default OFF
   * even when `enabled` — an irreversible apply is the most dangerous step, so it stays gated behind its own
   * switch AND the owner's per-action #13 approval until proven. Reversible/cheap applies need only `enabled`.
   */
  applyIrreversible: boolean;
}

/** The all-off default: the contract applies nothing. */
export const ACTION_CONTRACT_FLAGS_OFF: ActionContractFlags = { enabled: false, applyIrreversible: false };

/** The optional config block shape `resolveActionContractFlags` reads (a partial of the resolved config). */
export interface ActionContractConfigInput {
  enabled?: boolean;
  ownerWorkspaceOnly?: boolean;
  ownerWorkspaceId?: string;
  applyIrreversible?: boolean;
}

/**
 * Resolve the contract flags for a workspace — DEFAULT OFF, owner-workspace-first. The master `enabled`
 * must be on AND the workspace in scope (`ownerWorkspaceOnly` defaults true ⇒ only the named
 * `ownerWorkspaceId` is enabled). Turning `enabled` on WITHOUT naming the owner workspace enables nobody —
 * the safest default, identical to `delivery`/`skillopt`. Total and pure.
 */
export function resolveActionContractFlags(
  config: ActionContractConfigInput | undefined,
  workspaceId: string,
): ActionContractFlags {
  if (!config || config.enabled !== true) return ACTION_CONTRACT_FLAGS_OFF;
  const ownerOnly = config.ownerWorkspaceOnly !== false; // default true
  const inScope = ownerOnly
    ? config.ownerWorkspaceId !== undefined && config.ownerWorkspaceId === workspaceId
    : true;
  if (!inScope) return ACTION_CONTRACT_FLAGS_OFF;
  return { enabled: true, applyIrreversible: config.applyIrreversible === true };
}

/**
 * Whether an APPLY of `reversibility` class is permitted by `flags`. A disabled contract permits nothing.
 * Reversible/cheap applies need only the master flag; an IRREVERSIBLE apply additionally needs
 * `applyIrreversible` — the structural OFF-by-default guard for the most dangerous step (#200 §4). Pure.
 */
export function canApply(flags: ActionContractFlags, reversibility: ReversibilityClass): boolean {
  if (!flags.enabled) return false;
  if (reversibility === "irreversible") return flags.applyIrreversible;
  return true;
}
