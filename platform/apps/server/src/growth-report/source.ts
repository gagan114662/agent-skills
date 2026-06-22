/**
 * Weekly growth report — the **data-source seam** (issue #620).
 *
 * {@link GrowthDataSource} is the narrow interface the service consumes: given a workspace and a week, return
 * that week's raw {@link WeeklyGrowthData} (metrics + experiments). The production binding (wiring this to the
 * real analytics/funnel/experiment repositories) would touch shared files, so it is a deliberate follow-up;
 * see `growth-report/default.ts`.
 *
 * The default binding is {@link FakeGrowthDataSource} — a **deterministic** generator seeded from the
 * workspace id + week, so the module produces a coherent, data-backed report with **zero external calls**
 * until a real source is wired in and the feature is enabled. Determinism (no clock, no `Math.random`) is
 * what lets the acceptance test assert on an exact report.
 */

import type {
  ExperimentInput,
  MetricInput,
  ReportPeriod,
  WeeklyGrowthData,
} from "./types.js";

/** Supplies one workspace-week of raw growth data to the report service. */
export interface GrowthDataSource {
  /** Fetch the metrics + experiments for `workspaceId` over `period`. */
  fetch(workspaceId: string, period: ReportPeriod): Promise<WeeklyGrowthData>;
}

/** FNV-1a 32-bit hash — a stable, dependency-free seed from a string. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG — deterministic uniform [0, 1) from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A deterministic, offline {@link GrowthDataSource}. Seeded from `workspaceId` + `weekStart`, so the same
 * workspace-week always yields the same numbers and the report is reproducible. Used as the safe default
 * binding (no network, no DB) and by unit tests.
 */
export class FakeGrowthDataSource implements GrowthDataSource {
  async fetch(workspaceId: string, period: ReportPeriod): Promise<WeeklyGrowthData> {
    const rand = mulberry32(fnv1a(`${workspaceId}:${period.weekStart}`));

    // A small, realistic swing on each metric — some up, some down — derived from the seed.
    const swing = (lo: number, hi: number): number => lo + (hi - lo) * rand();
    const around = (base: number, pct: number): number => Math.round(base * (1 + swing(-pct, pct)));

    const priorSignups = around(120, 0.2);
    const priorActivations = around(70, 0.2);
    const priorMrr = around(4200, 0.15);
    const priorChurn = Math.max(1, around(40, 0.3)) / 10; // a small percentage like 3.8

    const metrics: MetricInput[] = [
      {
        key: "signups",
        label: "New signups",
        value: Math.round(priorSignups * (1 + swing(-0.15, 0.25))),
        priorValue: priorSignups,
        unit: "count",
      },
      {
        key: "activations",
        label: "Activated users",
        value: Math.round(priorActivations * (1 + swing(-0.15, 0.2))),
        priorValue: priorActivations,
        unit: "count",
      },
      {
        key: "mrr",
        label: "MRR",
        value: Math.round(priorMrr * (1 + swing(-0.1, 0.18))),
        priorValue: priorMrr,
        unit: "usd",
      },
      {
        key: "churn_rate",
        label: "Churn rate",
        value: Math.round(priorChurn * (1 + swing(-0.2, 0.2)) * 10) / 10,
        priorValue: priorChurn,
        unit: "%",
        higherIsBetter: false,
      },
    ];

    const statuses: ExperimentInput["status"][] = ["win", "loss", "inconclusive", "running"];
    const pick = <T>(arr: readonly T[]): T => {
      const idx = Math.min(arr.length - 1, Math.floor(rand() * arr.length));
      // `arr` is always non-empty at call sites; the fallback satisfies noUncheckedIndexedAccess.
      return arr[idx] as T;
    };

    const experiments: ExperimentInput[] = [
      {
        id: `${workspaceId}-exp-1`,
        name: "Pricing page social proof",
        hypothesis: "Adding customer logos to the pricing page lifts signups.",
        status: "win",
        metricKey: "signups",
        lift: Math.round(swing(0.05, 0.2) * 1000) / 1000,
      },
      {
        id: `${workspaceId}-exp-2`,
        name: "Onboarding checklist",
        hypothesis: "A guided checklist improves activation.",
        status: pick(statuses),
        metricKey: "activations",
        lift: Math.round(swing(-0.1, 0.15) * 1000) / 1000,
      },
      {
        id: `${workspaceId}-exp-3`,
        name: "Win-back email sequence",
        hypothesis: "A three-touch win-back sequence reduces churn.",
        status: "running",
        metricKey: "churn_rate",
      },
    ];

    return { workspaceId, period, metrics, experiments };
  }
}

/**
 * A {@link GrowthDataSource} that returns pre-canned data — for tests that want to assert on an exact report
 * shape rather than the seeded fake. Throws if asked for a workspace it has no data for.
 */
export class StaticGrowthDataSource implements GrowthDataSource {
  constructor(private readonly byWorkspace: Map<string, WeeklyGrowthData>) {}

  async fetch(workspaceId: string, period: ReportPeriod): Promise<WeeklyGrowthData> {
    const data = this.byWorkspace.get(workspaceId);
    if (!data) throw new Error(`StaticGrowthDataSource: no data for workspace ${workspaceId}`);
    return { ...data, workspaceId, period };
  }
}
