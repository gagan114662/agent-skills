import type { NotificationPrefs } from "../notifications/types.js";
import { shouldNotify } from "../notifications/types.js";
import type { MissionDiagnostic, RecentFailureView } from "./diagnose.js";

export const ACTIVATION_HEALTH_ALERT_THRESHOLD_MS = 5 * 60_000;

export function shouldQueueActivationHealthAlert(input: {
  diagnostic: MissionDiagnostic;
  recentFailures: RecentFailureView[];
  nowMs: number;
  prefs: NotificationPrefs;
  existing: ReadonlyArray<{ type: string; excerpt: string | null }>;
}): boolean {
  if (!shouldNotify("activation_health", input.prefs)) return false;
  if (input.existing.some((n) => n.type === "activation_health" && n.excerpt === input.diagnostic.headline)) {
    return false;
  }
  if (input.diagnostic.state === "sessions_failing") {
    const newestFailureMs = Math.max(...input.recentFailures.map((f) => f.endedAtMs ?? input.nowMs), 0);
    return input.nowMs - newestFailureMs >= ACTIVATION_HEALTH_ALERT_THRESHOLD_MS;
  }
  return input.diagnostic.state === "no_work";
}
