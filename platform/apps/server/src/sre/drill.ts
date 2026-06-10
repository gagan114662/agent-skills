import type { SreEngine } from "./engine.js";
import type { ServiceSignal } from "./types.js";

/**
 * Game-day chaos drill (#112, ADR-0112 §9) — like the #99 `dr:drill`. It **injects** a degraded
 * signal (Redis down, PG slow/down, api erroring) into the SRE Loop and proves the on-call path fires:
 * an incident opens and a triage session is launched. Pure orchestration over `engine.tickWorkspace`
 * (the injected signals stand in for `/metrics` + health), so it is unit-tested and the CLI reuses it
 * against a throwaway Postgres. A broken alert pipeline fails the drill loudly instead of at 2 a.m.
 */

/** The fault-injected signal map for a chaos drill: Redis down, PG down, api erroring + slow. */
export function chaosSignals(): Map<string, ServiceSignal> {
  return new Map<string, ServiceSignal>([
    ["api", { service: "api", windowRequests: 1000, windowErrors: 800, p95LatencyMs: 5000, queueLagSeconds: 0, healthy: true }],
    ["db", { service: "db", windowRequests: 0, windowErrors: 0, p95LatencyMs: 0, queueLagSeconds: 0, healthy: false }],
    ["redis", { service: "redis", windowRequests: 0, windowErrors: 0, p95LatencyMs: 0, queueLagSeconds: 0, healthy: false }],
  ]);
}

export interface ChaosDrillResult {
  ok: boolean;
  incidentsOpened: number;
  triageLaunches: number;
  details: string[];
}

/**
 * Run one chaos tick and assert the on-call path fired. `launchCount` reads the injected triage
 * launcher's call count (the drill uses a counting fake so CI never spawns a real agent).
 */
export async function runChaosDrill(input: {
  engine: SreEngine;
  workspaceId: string;
  signals: Map<string, ServiceSignal>;
  now: Date;
  launchCount: () => number;
}): Promise<ChaosDrillResult> {
  const result = await input.engine.tickWorkspace(input.workspaceId, input.signals, input.now);
  const opened = result.actions.filter((a) => a.action === "open" || a.action === "escalate");
  const triageLaunches = input.launchCount();

  const details = opened.map((a) => `${a.service}/${a.sloKind} → ${a.action} (${a.reason})`);
  if (result.skipped) details.push(`workspace pass skipped: ${result.skipped}`);

  const ok = opened.length > 0 && triageLaunches > 0;
  return { ok, incidentsOpened: opened.length, triageLaunches, details };
}
