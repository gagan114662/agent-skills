import type { CadenceConfig } from "../config/schema.js";

export interface WorkspaceCadenceGoal {
  objective: string;
  keyResult?: string;
  lead?: string;
  outcomeKey?: string;
}

/**
 * Autonomous work-cadence caps (#416, ADR-0416) — pure policy for whether the recurring tick that keeps the
 * fleet working on ipop.ai's own growth runs, and how conservatively. Mirrors `venture-factory/caps.ts` /
 * `subagents/collaboration.ts`: a two-pronged gate that is **DEFAULT OFF** and **owner-workspace-first**,
 * resolved with hard defaults from the layered config (#58).
 *
 * The cadence autonomously LAUNCHES sessions, which spends model tokens — so it ships OFF (`enabled: false`,
 * `intervalMs: 0`) and rolls out to the owner's own workspace first. A deployment that sets nothing runs no
 * ticks at all (the timer is never started; see `index.ts`), so behavior is byte-for-byte unchanged. The
 * launches are draft-only briefs through the existing #13-gated path — the cadence adds NO new money/send
 * authority; the per-day cap and one-launch-per-tick are pure conservatism on top.
 */
export interface CadenceCaps {
  /** The master cadence flag — OFF by default. Gates whether any autonomous brief is launched. */
  enabled: boolean;
  /**
   * When true (default), the cadence only runs in the OWNER's own workspace — the safest first blast radius.
   * Set false to run for all tenants once the owner has proven the loop.
   */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the cadence dogfoods here first. */
  ownerWorkspaceId: string | undefined;
  /**
   * The timer interval in ms. Default `0` = OFF (the timer is never started). Set > 0 to opt the background
   * loop in. Mirrors `VENTURE_FACTORY_INTERVAL_MS`: the timer wiring lives in `index.ts`.
   */
  intervalMs: number;
  /**
   * The HARD per-workspace per-day launch cap. The engine launches AT MOST this many briefs per UTC day,
   * then skips — a runaway timer can never outspend this. Default 12 (conservative).
   */
  maxLaunchesPerDay: number;
  /** Workspace goals/OKRs that override the generic dogfood playbook when present (#522). */
  goals: readonly WorkspaceCadenceGoal[];
}

export const CADENCE_DEFAULTS: CadenceCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: undefined,
  intervalMs: 0,
  maxLaunchesPerDay: 12,
  goals: [],
};

/** Resolve the cadence caps from the layered config, applying hard defaults. */
export function resolveCadenceCaps(cfg: CadenceConfig | undefined): CadenceCaps {
  return {
    enabled: cfg?.enabled ?? CADENCE_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? CADENCE_DEFAULTS.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? CADENCE_DEFAULTS.ownerWorkspaceId,
    intervalMs: cfg?.intervalMs ?? CADENCE_DEFAULTS.intervalMs,
    maxLaunchesPerDay: cfg?.maxLaunchesPerDay ?? CADENCE_DEFAULTS.maxLaunchesPerDay,
    goals: cfg?.goals ?? CADENCE_DEFAULTS.goals,
  };
}

/**
 * Pure: is the cadence ENABLED for this specific workspace (#416)? Mirrors `isSpawnEnabledForWorkspace`:
 * the capability rolls out owner-workspace-first, so even when the master `enabled` flag is on, an
 * `ownerWorkspaceOnly` deployment (the default) only runs for the named owner workspace, and every other
 * tenant stays OFF. Turning `enabled` on WITHOUT naming the owner workspace runs for nobody (the safest
 * default, matching `agentCollaboration`/`ventureFactory`). Set `ownerWorkspaceOnly` false for all tenants.
 */
export function isCadenceEnabledForWorkspace(caps: CadenceCaps, workspaceId: string): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== undefined && caps.ownerWorkspaceId === workspaceId;
}
