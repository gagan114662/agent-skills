/**
 * Signal-source seam for hot-prospect alerting (issue #622). The narrow interface the service reads recent
 * prospect activity through — interface only, no IO — so the service is unit-testable against an in-memory
 * fixture and a real deployment can later bind a production source (the #604 funnel events, #386 exposures,
 * web analytics, …) WITHOUT touching this module. That binding is the only place real activity is read; until
 * it exists, the deterministic {@link FixtureSignalSource} is the default and makes no external call.
 *
 * Every method is workspace-scoped (the `workspaceId` argument) so a caller only ever sees its own tenant's
 * activity — the #3 IDOR boundary.
 */

import type { ProspectActivity, ProspectSignal, ProspectSignalKind } from "./types.js";

/** Reads recent prospect activity for a workspace. The detector windows whatever this returns. */
export interface SignalSource {
  /** Recent prospect activity for a workspace. Order is irrelevant; the detector sorts + windows it. */
  recentActivity(workspaceId: string): Promise<ProspectActivity[]>;
}

/**
 * Deterministic in-memory {@link SignalSource} for tests and the default (disabled) production wiring. Holds a
 * per-workspace map of activity; reads return deep copies so a caller cannot mutate stored state through the
 * result. Makes NO external call — the safe default until a real source is bound.
 */
export class FixtureSignalSource implements SignalSource {
  private readonly byWorkspace = new Map<string, ProspectActivity[]>();

  constructor(seed?: Record<string, ProspectActivity[]>) {
    if (seed) {
      for (const [ws, activities] of Object.entries(seed)) {
        this.byWorkspace.set(ws, activities.map(cloneActivity));
      }
    }
  }

  /** Replace the activity for a workspace (test helper). */
  set(workspaceId: string, activities: ProspectActivity[]): void {
    this.byWorkspace.set(workspaceId, activities.map(cloneActivity));
  }

  async recentActivity(workspaceId: string): Promise<ProspectActivity[]> {
    return (this.byWorkspace.get(workspaceId) ?? []).map(cloneActivity);
  }
}

function cloneActivity(a: ProspectActivity): ProspectActivity {
  return {
    prospectId: a.prospectId,
    ...(a.label !== undefined ? { label: a.label } : {}),
    signals: a.signals.map((s) => ({ ...s })),
  };
}

/**
 * Build a deterministic "high-intent" activity fixture: `repeat` events of `kind` spaced `gapMinutes` apart,
 * ending at `endMs`. Used by the #622 acceptance simulation ("visited pricing 3x today") and any caller that
 * wants a reproducible hot prospect without a clock.
 */
export function simulateHighIntent(opts: {
  prospectId: string;
  label?: string;
  kind: ProspectSignalKind;
  repeat: number;
  endMs: number;
  gapMinutes?: number;
  detail?: string;
}): ProspectActivity {
  const gap = (opts.gapMinutes ?? 30) * 60 * 1000;
  const signals: ProspectSignal[] = [];
  for (let i = 0; i < opts.repeat; i++) {
    // Most recent event at endMs, earlier ones spaced back by `gap` — all within a "today" window.
    const at = new Date(opts.endMs - i * gap).toISOString();
    signals.push({ kind: opts.kind, at, ...(opts.detail !== undefined ? { detail: opts.detail } : {}) });
  }
  return {
    prospectId: opts.prospectId,
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    signals,
  };
}
