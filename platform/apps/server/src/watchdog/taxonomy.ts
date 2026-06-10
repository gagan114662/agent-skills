import type { SessionStatus } from "../db/repositories/agent-sessions.js";

/**
 * The pure failure taxonomy (#105 acceptance #3). Maps a session's status (+ exit code) to a class
 * and a `retryable` flag the watchdog persists on the revival record and feeds to `decideRevival`.
 * This is how the watchdog "learns which errors are retryable" — a transient blip is revived (within
 * the bounded policy); a permanent break (a non-zero agent exit, a human cancel) escalates straight
 * to a human and is never retried forever.
 */
export type FailureClass =
  | "stalled"
  | "timeout"
  | "idle"
  | "crashed"
  | "canceled"
  | "completed"
  | "unknown";

export interface FailureClassification {
  class: FailureClass;
  retryable: boolean;
}

/** A non-terminal session detected without recent progress (the network-blip premortem case). */
type StalledMarker = "stalled";

export function classifyFailure(
  status: SessionStatus | StalledMarker,
  exitCode?: number | null,
): FailureClassification {
  switch (status) {
    case "stalled":
    case "provisioning":
    case "running":
      // A live session with no recent heartbeat — most likely a transient blip; worth a revival.
      return { class: "stalled", retryable: true };
    case "timeout":
      return { class: "timeout", retryable: true };
    case "idle_reaped":
      return { class: "idle", retryable: true };
    case "failed":
      // No exit code → the process died (a crash/connection blip), worth a revival. A non-zero exit
      // means the agent itself terminated with an error — reviving the same work would loop on it.
      return { class: "crashed", retryable: exitCode === null || exitCode === undefined };
    case "canceled":
      // A human stopped it on purpose — never revive what a human cancelled.
      return { class: "canceled", retryable: false };
    case "completed":
      return { class: "completed", retryable: false };
    default:
      return { class: "unknown", retryable: false };
  }
}
