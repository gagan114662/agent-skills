/**
 * Live coordination feed (#362) — the PURE decision layer that turns the #147 mission-control strip from a
 * fixed 4s poll into socket-driven, real-time delivery, while keeping the poll as a fail-closed FALLBACK.
 *
 * Two pieces, both pure and unit-tested without a DOM, a clock, or a socket:
 *   · {@link isMissionLiveEvent} — which realtime events mean "the live strip / coordination roll-up may have
 *     changed" (a new agent message / handoff, or an agent session lifecycle change). The hook refetches the
 *     instant one lands, so a delegation/handoff shows up within the socket round-trip, not the poll cadence.
 *   · {@link shouldRefetchMission} — the poll FALLBACK gate: when the socket is proving live the poll backs off
 *     to a slow heartbeat floor; when the socket is unavailable it refetches every tick at exactly the prior
 *     4s cadence — so the surface is never worse than it is today (graceful degrade, #200 fail-closed).
 *
 * #200: this module makes NO request and opens NO action path; it only decides timing. Message content stays
 * DATA, rendered as React text downstream (the #352 invariant) — nothing here ever interprets a payload.
 */
import type { ServerEvent } from "../../api/types.js";

/**
 * Realtime event types that should trigger an immediate mission-control refetch. A channel `message` is how an
 * agent handoff/delegation surfaces; `run_status`/`deploy_status` are session lifecycle changes (a session
 * started/exited/failed); `notification` covers an assignment/approval nudge. Presence and mentions are already
 * applied live by the store, so they are intentionally excluded — refetching the strip on them would be noise.
 * `satisfies` pins every entry to a real `ServerEvent["type"]` so a renamed/removed event fails the build.
 */
export const MISSION_LIVE_EVENT_TYPES = [
  "message",
  "run_status",
  "deploy_status",
  "notification",
] as const satisfies readonly ServerEvent["type"][];

const LIVE_EVENT_SET: ReadonlySet<string> = new Set(MISSION_LIVE_EVENT_TYPES);

/** True when an event signals the live strip / coordination roll-up may have changed (see the list above). */
export function isMissionLiveEvent(type: ServerEvent["type"]): boolean {
  return LIVE_EVENT_SET.has(type);
}

/** The poll FALLBACK cadence — matches the prior fixed 4s mission-control poll EXACTLY, so a socket outage
 * degrades to today's behaviour and never anything slower. */
export const MISSION_POLL_FALLBACK_MS = 4000;
/** How recently a socket event must have arrived for the socket to count as "live" (drives the back-off). */
export const MISSION_LIVE_WINDOW_MS = 15000;
/** When the socket is live, the slow heartbeat floor — a backstop refetch in case an event was ever dropped. */
export const MISSION_HEARTBEAT_MS = 30000;

export interface MissionPollInput {
  /** Now, in epoch ms (passed in — this module never reads the clock, so it stays pure/testable). */
  readonly nowMs: number;
  /** When the last mission-relevant socket event arrived, or null if none yet this session. */
  readonly lastEventAtMs: number | null;
  /** When mission control was last (attempted) fetched, or null if never. */
  readonly lastFetchAtMs: number | null;
  /** Override the live window (defaults to {@link MISSION_LIVE_WINDOW_MS}). */
  readonly liveWindowMs?: number;
  /** Override the heartbeat floor (defaults to {@link MISSION_HEARTBEAT_MS}). */
  readonly heartbeatMs?: number;
}

/**
 * On each base (4s) tick, decide whether the poll FALLBACK should refetch mission control. The socket is the
 * primary path — a relevant event triggers an immediate refetch elsewhere — so this only governs the poll:
 *
 *   · socket NOT proven live (no event within the window) ⇒ refetch every tick (== today's 4s cadence)
 *   · socket live, but nothing fetched yet                 ⇒ refetch (first paint)
 *   · socket live and recently fetched                     ⇒ skip, EXCEPT a slow heartbeat floor so a dropped
 *                                                            event can never strand the strip
 *
 * Pure: never reads the clock, never throws.
 */
export function shouldRefetchMission(input: MissionPollInput): boolean {
  const liveWindow = input.liveWindowMs ?? MISSION_LIVE_WINDOW_MS;
  const heartbeat = input.heartbeatMs ?? MISSION_HEARTBEAT_MS;
  const socketLive =
    input.lastEventAtMs !== null && input.nowMs - input.lastEventAtMs <= liveWindow;
  if (!socketLive) return true;
  if (input.lastFetchAtMs === null) return true;
  return input.nowMs - input.lastFetchAtMs >= heartbeat;
}
