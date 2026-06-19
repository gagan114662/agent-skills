/**
 * Live coordination feed (#362) — the React hook that turns the #147 mission-control strip from a fixed 4s
 * poll into socket-driven, real-time delivery, with the poll kept as a fail-closed FALLBACK.
 *
 * How it works:
 *   · PRIMARY (real-time): it taps the store's single realtime stream (`store.onRealtimeEvent`) and refetches
 *     mission control the instant a mission-relevant event lands (a new agent message / handoff, or a session
 *     lifecycle change). So a delegation/handoff shows in the strip within the socket round-trip — no 4s wait.
 *   · FALLBACK (poll): a base tick at the prior {@link MISSION_POLL_FALLBACK_MS} cadence asks the pure
 *     {@link shouldRefetchMission} whether to refetch. While the socket is proving live it backs off to a slow
 *     heartbeat floor; when the socket is unavailable it refetches every tick exactly as today — never worse.
 *
 * #200: read-only. It opens NO new action path and never interprets a payload — message content stays DATA,
 * rendered as React text by the downstream components (the #352 invariant). It only decides WHEN to refetch.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { useStore } from "../../store/StoreContext.js";
import type { MissionControlDto } from "../../api/types.js";
import { isMissionLiveEvent, shouldRefetchMission, MISSION_POLL_FALLBACK_MS } from "./mission-live.js";

export interface LiveMissionControl {
  /** The latest mission-control roll-up, or null before the first fetch resolves. */
  data: MissionControlDto | null;
  /** Force an immediate refetch (e.g. after a stop/steer action). Best-effort; never throws. */
  refresh: () => Promise<void>;
}

/**
 * Subscribe the #147 mission-control strip to live websocket events, with a polling fallback. Pass the current
 * workspace id (undefined before identity loads → inert: no fetch, no socket subscription, no timer).
 */
export function useLiveMissionControl(workspaceId: string | undefined): LiveMissionControl {
  const store = useStore();
  const [data, setData] = useState<MissionControlDto | null>(null);

  // Guards every async setState so a fetch that resolves after unmount is a no-op (no leak / no warning).
  const mounted = useRef(true);
  // Serializes fetches so an event burst + the poll tick never overlap into a thundering herd.
  const inFlight = useRef(false);
  // Liveness bookkeeping the pure poll decision reads (kept in refs so they never trigger a re-render).
  const lastEventAtMs = useRef<number | null>(null);
  const lastFetchAtMs = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!workspaceId || inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await api.missionControl.get(workspaceId);
      lastFetchAtMs.current = Date.now();
      if (mounted.current) setData(next);
    } catch {
      /* transient; the poll fallback retries on the next tick */
    } finally {
      inFlight.current = false;
    }
  }, [workspaceId]);

  // PRIMARY path: refetch the instant a mission-relevant socket event lands. This is what makes a new agent
  // message / handoff / session change appear within ~the round-trip instead of on the fixed poll cadence.
  useEffect(() => {
    if (!workspaceId) return;
    return store.onRealtimeEvent((event) => {
      if (!isMissionLiveEvent(event.type)) return;
      lastEventAtMs.current = Date.now();
      void refresh();
    });
  }, [workspaceId, store, refresh]);

  // FALLBACK poll: an initial fetch on mount, then a base tick that only refetches when the pure decision says
  // to — every tick when the socket is down (== today's 4s cadence), a slow heartbeat floor while it is live.
  useEffect(() => {
    if (!workspaceId) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (
        shouldRefetchMission({
          nowMs: Date.now(),
          lastEventAtMs: lastEventAtMs.current,
          lastFetchAtMs: lastFetchAtMs.current,
        })
      ) {
        void refresh();
      }
    }, MISSION_POLL_FALLBACK_MS);
    return () => window.clearInterval(timer);
  }, [workspaceId, refresh]);

  return { data, refresh };
}
