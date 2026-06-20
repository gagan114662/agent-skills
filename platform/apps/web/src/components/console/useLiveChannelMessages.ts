/**
 * Live channel feed (#419) — keeps the OPEN channel's messages fresh without a manual refresh, the message-feed
 * sibling of the #362 mission-control live hook.
 *
 * Why it exists: the realtime `message` event is the PRIMARY path and the store already appends it to the open
 * channel (`applyEvent`). But if a socket event is ever dropped — or the socket never connects in a flaky /
 * cross-site context (#418) — the channel would strand until the user reloaded the page. That is exactly the
 * #419 symptom ("I don't see any response from the agent" → only a manual refresh surfaced it).
 *
 * How it works (mirrors useLiveMissionControl):
 *   · PRIMARY (real-time): a `message` event for the active channel is already applied by the store; here we
 *     only note "the socket is live" so the poll backs off — we don't double-fetch the happy path.
 *   · FALLBACK (poll): a base tick asks the shared, pure {@link shouldRefetchMission} timing decision whether to
 *     re-fetch. Socket proven live → slow heartbeat floor (a dropped event still self-heals); socket down →
 *     refetch every tick. The refetch UPSERTS (store.refreshChannelMessages), so it never drops a live arrival.
 *
 * #200: read-only. It opens NO action path and never interprets a payload — message content stays DATA, rendered
 * as React text downstream. It only decides WHEN to re-fetch the channel it is already showing.
 */
import { useEffect, useRef } from "react";
import { useStore } from "../../store/StoreContext.js";
// Reuse the #362 poll-decision (generic socket-live-vs-poll timing) and its base cadence — same shape, so the
// channel feed degrades identically to the mission strip rather than duplicating the logic.
import { shouldRefetchMission, MISSION_POLL_FALLBACK_MS } from "./mission-live.js";

/**
 * Keep `channelId`'s messages fresh as a fallback to the realtime stream. Pass the active channel id, or null
 * before one is selected → inert (no timer, no socket tap, no fetch).
 */
export function useLiveChannelMessages(channelId: string | null): void {
  const store = useStore();
  // Liveness bookkeeping the pure poll decision reads (refs → never trigger a re-render).
  const lastEventAtMs = useRef<number | null>(null);
  const lastFetchAtMs = useRef<number | null>(null);

  // PRIMARY: note that the socket is delivering events for THIS channel so the poll can back off. The store
  // already applied the message to state — we don't refetch here, we just record liveness.
  useEffect(() => {
    if (!channelId) return;
    lastEventAtMs.current = null;
    lastFetchAtMs.current = null;
    return store.onRealtimeEvent((event) => {
      if (event.type === "message" && event.message.channelId === channelId) {
        lastEventAtMs.current = Date.now();
      }
    });
  }, [channelId, store]);

  // FALLBACK poll: on each base tick, refetch only when the shared decision says to — every tick when the socket
  // is down (self-heals a never-delivered event), a slow heartbeat floor while it is proven live.
  useEffect(() => {
    if (!channelId) return;
    const timer = window.setInterval(() => {
      if (
        shouldRefetchMission({
          nowMs: Date.now(),
          lastEventAtMs: lastEventAtMs.current,
          lastFetchAtMs: lastFetchAtMs.current,
        })
      ) {
        lastFetchAtMs.current = Date.now();
        void store.refreshChannelMessages(channelId);
      }
    }, MISSION_POLL_FALLBACK_MS);
    return () => window.clearInterval(timer);
  }, [channelId, store]);
}
