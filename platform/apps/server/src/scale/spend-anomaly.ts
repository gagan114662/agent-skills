import type { ResolvedConfig } from "../config/schema.js";
import { resolveScaleCaps } from "./caps.js";
import { estimateCostCents, windowKey, type UsageReader } from "./usage.js";
import {
  liveSpendRegistry,
  type LiveSessionSpend,
  type LiveSpendRegistry,
  type SpendAlertThreshold,
} from "./live-spend.js";

export interface SpendAnomalySessionInput {
  sessionId: string;
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
  createdByMemberId: string;
  task: string;
  startedAtMs: number;
}

export interface SpendGuardCheck {
  live: LiveSessionSpend;
  alerts: SpendAlertThreshold[];
  kill: boolean;
  reason: string | null;
}

export interface SpendGuardSession {
  check(elapsedSeconds: number): Promise<SpendGuardCheck>;
  close(): void;
}

export interface SpendAnomalyMonitor {
  begin(input: SpendAnomalySessionInput): Promise<SpendGuardSession | null>;
}

export interface SpendAlert {
  session: SpendAnomalySessionInput;
  threshold: SpendAlertThreshold;
  live: LiveSessionSpend;
}

export interface SpendKill {
  session: SpendAnomalySessionInput;
  live: LiveSessionSpend;
  reason: string;
}

export interface SpendAnomalyMonitorDeps {
  usage: UsageReader;
  config: (workspaceId: string) => ResolvedConfig;
  registry?: LiveSpendRegistry;
  now?: () => Date;
  onAlert?: (alert: SpendAlert) => Promise<void>;
  onKill?: (kill: SpendKill) => Promise<void>;
}

const ALERT_THRESHOLDS: SpendAlertThreshold[] = [50, 75, 90, 100];

export function createSpendAnomalyMonitor(deps: SpendAnomalyMonitorDeps): SpendAnomalyMonitor {
  const registry = deps.registry ?? liveSpendRegistry;
  const now = deps.now ?? (() => new Date());
  return {
    async begin(session) {
      const caps = resolveScaleCaps(deps.config(session.workspaceId).scale);
      if (caps.budgetCents <= 0 || caps.computeRateCentsPerMinute <= 0) return null;

      const window = windowKey(now());
      const startUsage = await deps.usage.read(session.workspaceId, window);
      const alreadyAlerted = new Set<SpendAlertThreshold>();
      let killed = false;

      return {
        async check(elapsedSeconds) {
          const estimatedCostCents = estimateCostCents(
            elapsedSeconds,
            caps.computeRateCentsPerMinute,
          );
          const projectedWindowCost = startUsage.estimatedCostCents + estimatedCostCents;
          const utilization = projectedWindowCost / caps.budgetCents;
          const crossed = ALERT_THRESHOLDS.filter((threshold) => utilization >= threshold / 100);
          const alerts = crossed.filter((threshold) => !alreadyAlerted.has(threshold));
          for (const threshold of alerts) alreadyAlerted.add(threshold);

          const remainingAtStart = Math.max(0, caps.budgetCents - startUsage.estimatedCostCents);
          const sessionDrainLimit = Math.max(1, Math.ceil(remainingAtStart * 0.5));
          const kill =
            !killed &&
            (estimatedCostCents >= sessionDrainLimit || projectedWindowCost >= caps.budgetCents);
          const reason = kill
            ? estimatedCostCents >= sessionDrainLimit
              ? "session_spend_exceeded_half_remaining_budget"
              : "workspace_budget_exceeded"
            : null;
          if (kill) killed = true;

          const live: LiveSessionSpend = {
            sessionId: session.sessionId,
            workspaceId: session.workspaceId,
            channelId: session.channelId,
            agentMemberId: session.agentMemberId,
            startedAtMs: session.startedAtMs,
            elapsedSeconds,
            estimatedCostCents,
            budgetCents: caps.budgetCents,
            utilization,
            threshold: crossed.at(-1) ?? null,
          };
          registry.upsert(live);

          for (const threshold of alerts) await deps.onAlert?.({ session, threshold, live });
          if (kill && reason) await deps.onKill?.({ session, live, reason });
          return { live, alerts, kill, reason };
        },
        close() {
          registry.remove(session.sessionId);
        },
      };
    },
  };
}
