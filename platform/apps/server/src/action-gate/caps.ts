/**
 * Action-gate config (issue #670). Deliberately **self-contained**: the few tunables are read directly from the
 * process environment, so this feature adds NO edit to the shared `config/schema.ts` barrel and stays free of
 * parallel-merge conflicts with sibling branches.
 *
 * As with the #674 content-guard, this is a SAFETY guardrail, NOT a feature flag. There is intentionally NO
 * master off-switch: the confirmation requirement for public/irreversible actions is not configurable away. The
 * environment can only ever make the gate STRICTER (add verbs to the danger lists) or set operational knobs
 * (how long an unactioned approval stays valid). The known-safe verb list can be extended for a deployment's
 * own internal ops, but that can never override a danger verb (see `classify.ts`).
 */

import type { ClassifyPolicy } from "./classify.js";

/** Default time an approval (or a pending request) stays valid before it lazily expires: 7 days. */
export const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ActionGateCaps extends ClassifyPolicy {
  /** How long an approval / pending request stays valid before it lazily expires (ms). */
  approvalTtlMs: number;
}

export const ACTION_GATE_DEFAULTS: ActionGateCaps = {
  approvalTtlMs: DEFAULT_APPROVAL_TTL_MS,
  extraIrreversibleVerbs: [],
  extraPublicVerbs: [],
  extraSafeVerbs: [],
};

/** Parse a comma/space separated verb list; empty/missing ⇒ no extra verbs. Lowercased, de-duped, trimmed. */
function parseVerbList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((v) => v.trim().toLowerCase())
        .filter((v) => v.length > 0),
    ),
  ];
}

/** Parse a positive-integer TTL (ms); a missing/invalid/non-positive value keeps the 7-day default. */
function parseTtlMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_APPROVAL_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_APPROVAL_TTL_MS;
  return Math.trunc(n);
}

/** Resolve the action-gate caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveActionGateCaps(env: NodeJS.ProcessEnv = process.env): ActionGateCaps {
  return {
    approvalTtlMs: parseTtlMs(env.ACTION_GATE_APPROVAL_TTL_MS),
    extraIrreversibleVerbs: parseVerbList(env.ACTION_GATE_EXTRA_IRREVERSIBLE),
    extraPublicVerbs: parseVerbList(env.ACTION_GATE_EXTRA_PUBLIC),
    extraSafeVerbs: parseVerbList(env.ACTION_GATE_EXTRA_SAFE),
  };
}
