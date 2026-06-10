import type { ResolvedConfig } from "../config/schema.js";
import { decideAdmission, type AdmissionReason } from "./decide.js";
import { resolveScaleCaps } from "./caps.js";
import { planRegion, type RegionLoad } from "./region.js";
import { budgetExceeded, windowKey, type UsageReader } from "./usage.js";

/**
 * Admission control (#71) — the single chokepoint every launch passes through (`SessionManager`).
 * It is the IO orchestrator over the pure `decide`/`region` logic (the #17 pattern): it gathers the
 * inputs (the tenant's caps from config, the #17 kill switch, this window's usage, the live
 * counters), asks {@link decideAdmission}, and — when admitted — **places** the session in the
 * least-loaded allowed region and hands back a ticket that releases the slot at teardown.
 *
 * Counters are held in memory on the server that owns the session lifecycle (the same place the
 * #25 SessionManager already tracks `running`). Global + per-tenant counters bound concurrency;
 * per-region counters drive placement. A denied launch throws {@link AdmissionError} so the launch
 * route can map it to 429/402 and **no session row is created**.
 */

/** The #17 kill-switch seam (the autonomy `getControls` repo satisfies this). */
export interface KillSwitchReader {
  isEngaged(workspaceId: string): Promise<boolean>;
}

export interface AdmissionDeps {
  /** This-window usage, for the budget check. */
  usage: UsageReader;
  /** The #17 kill switch. */
  killSwitch: KillSwitchReader;
  /** Resolve a tenant's config — caps/budget/regions live in its managed/per-tenant layer (#58). */
  config: (workspaceId: string) => ResolvedConfig;
  /** Fleet-wide in-flight ceiling; 0 = unlimited (the server default derives from TEAM_MAX_CONCURRENCY). */
  globalMax: number;
  /** Injectable clock for the usage window (tests pin it; prod uses the real clock). */
  now?: () => Date;
  /** Metric hook: a session was placed in a region (prod passes the #19 counter; tests omit it). */
  onPlace?: (region: string) => void;
}

/** A granted admission: where the session was placed + a one-shot release of its slot. */
export interface AdmissionTicket {
  /** The region the session was placed in, or undefined when the tenant configures no regions. */
  readonly region?: string;
  /** Free the slot (idempotent). Called by the SessionManager at teardown, on every path. */
  release(): void;
}

/**
 * The narrow seam the SessionManager admits launches through. {@link Admission} satisfies it; tests
 * inject a fake to assert the manager honours a denial / threads the placed region without standing
 * up the real counters + config.
 */
export interface AdmissionController {
  acquire(workspaceId: string): Promise<AdmissionTicket>;
}

/** A point-in-time view of the live counters (the usage dashboard reads this). */
export interface AdmissionSnapshot {
  tenant: number;
  global: number;
  byRegion: Record<string, number>;
}

/** Thrown when a launch is denied. `reason` maps to an HTTP status at the route (429/402). */
export class AdmissionError extends Error {
  constructor(readonly reason: AdmissionReason) {
    super(`launch denied: ${reason}`);
    this.name = "AdmissionError";
  }
}

export class Admission {
  private global = 0;
  private readonly tenant = new Map<string, number>();
  private readonly region = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly deps: AdmissionDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Try to admit a launch. Resolves to a ticket, or throws {@link AdmissionError} on denial. */
  async acquire(workspaceId: string): Promise<AdmissionTicket> {
    const caps = resolveScaleCaps(this.deps.config(workspaceId).scale);
    const window = windowKey(this.now());
    const [killSwitch, usage] = await Promise.all([
      this.deps.killSwitch.isEngaged(workspaceId),
      this.deps.usage.read(workspaceId, window),
    ]);

    const decision = decideAdmission({
      killSwitch,
      budgetExceeded: budgetExceeded(usage.estimatedCostCents, caps.budgetCents),
      tenantInFlight: this.tenant.get(workspaceId) ?? 0,
      tenantMax: caps.tenantConcurrency,
      globalInFlight: this.global,
      globalMax: this.deps.globalMax,
    });
    if (!decision.ok) throw new AdmissionError(decision.reason);

    const region = planRegion(caps.regions, this.regionLoad(), caps.preferredRegion);
    this.global += 1;
    this.tenant.set(workspaceId, (this.tenant.get(workspaceId) ?? 0) + 1);
    if (region) {
      this.region.set(region, (this.region.get(region) ?? 0) + 1);
      this.deps.onPlace?.(region);
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.global = Math.max(0, this.global - 1);
      this.tenant.set(workspaceId, Math.max(0, (this.tenant.get(workspaceId) ?? 0) - 1));
      if (region) this.region.set(region, Math.max(0, (this.region.get(region) ?? 0) - 1));
    };
    return { region, release };
  }

  /** Live counters for a tenant (the usage dashboard surface). */
  snapshot(workspaceId: string): AdmissionSnapshot {
    return {
      tenant: this.tenant.get(workspaceId) ?? 0,
      global: this.global,
      byRegion: this.regionLoad(),
    };
  }

  private regionLoad(): RegionLoad {
    const out: RegionLoad = {};
    for (const [r, n] of this.region) out[r] = n;
    return out;
  }
}
