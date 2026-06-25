/**
 * `useTheaterStream` (issue #624) — subscribe a component to the live agent-theater SSE stream and
 * accumulate it into per-agent "lanes" ready to render.
 *
 * Each run becomes a lane: its header plus the ordered feed of reasoning → action → artifact events as
 * they land. Events are de-duplicated by id (a reconnect re-sends the tail), the feed is capped so a long
 * run can't grow memory without bound, and lanes are ordered by most-recent activity so the busiest agent
 * sits first. The stream client is injectable (`eventSourceFactory`) so this is testable with a fake in
 * jsdom. Read-only and content-as-data: summaries are rendered as React text downstream, never executed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  openTheaterStream,
  type EventSourceLike,
  type TheaterEventDto,
  type TheaterRunDto,
} from "../../api/theater.js";

/** Max events retained per lane — newest win; older ones scroll out of the live window. */
export const LANE_EVENT_CAP = 250;

export type TheaterStatus = "idle" | "connecting" | "live" | "reconnecting";

/** One agent's lane: the run header and its live feed of projected events. */
export interface TheaterLane {
  run: TheaterRunDto;
  events: TheaterEventDto[];
  /** Wall-clock (ms) of the latest event, for ordering the busiest lane first. */
  lastActivityMs: number;
}

export interface UseTheaterStream {
  lanes: TheaterLane[];
  status: TheaterStatus;
  /** Total events seen across all lanes this session (a simple liveness counter for the header). */
  eventCount: number;
}

interface LaneState {
  run: TheaterRunDto;
  events: TheaterEventDto[];
  seen: Set<string>;
  lastActivityMs: number;
}

function activityMs(event: TheaterEventDto): number {
  const t = Date.parse(event.occurredAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Subscribe to the workspace's live theater (or a single run when `runId` is given). Inert until a
 * `workspaceId` is known (no socket, no state) so it is safe to mount before identity resolves.
 */
export function useTheaterStream(
  workspaceId: string | undefined,
  runId?: string,
  eventSourceFactory?: (url: string) => EventSourceLike,
): UseTheaterStream {
  const [lanes, setLanes] = useState<Map<string, LaneState>>(new Map());
  const [status, setStatus] = useState<TheaterStatus>("idle");
  const [eventCount, setEventCount] = useState(0);
  // Hold the latest map in a ref so the SSE callbacks mutate-then-replace without stale closures.
  const lanesRef = useRef<Map<string, LaneState>>(lanes);
  lanesRef.current = lanes;

  useEffect(() => {
    if (!workspaceId) {
      setLanes(new Map());
      setStatus("idle");
      setEventCount(0);
      return;
    }
    if (!eventSourceFactory && typeof EventSource === "undefined") {
      setLanes(new Map());
      setStatus("idle");
      setEventCount(0);
      return;
    }
    setStatus("connecting");

    const upsertRun = (run: TheaterRunDto): void => {
      const next = new Map(lanesRef.current);
      const existing = next.get(run.id);
      next.set(run.id, {
        run,
        events: existing?.events ?? [],
        seen: existing?.seen ?? new Set<string>(),
        lastActivityMs: existing?.lastActivityMs ?? (Date.parse(run.startedAt) || 0),
      });
      lanesRef.current = next;
      setLanes(next);
    };

    const appendEvent = (event: TheaterEventDto): void => {
      const next = new Map(lanesRef.current);
      const lane = next.get(event.runId);
      const base: LaneState = lane ?? {
        // An event can arrive before its run header on a flaky reconnect — synthesize a placeholder lane.
        run: {
          id: event.runId,
          workspaceId,
          sessionId: null,
          agentMemberId: null,
          taskId: null,
          label: event.label,
          status: "open",
          eventCount: 0,
          startedAt: event.occurredAt,
          endedAt: null,
        },
        events: [],
        seen: new Set<string>(),
        lastActivityMs: 0,
      };
      if (base.seen.has(event.id)) {
        next.set(event.runId, base);
        return; // duplicate (reconnect tail) — ignore
      }
      const seen = new Set(base.seen);
      seen.add(event.id);
      const events = [...base.events, event].slice(-LANE_EVENT_CAP);
      next.set(event.runId, {
        ...base,
        events,
        seen,
        lastActivityMs: Math.max(base.lastActivityMs, activityMs(event)),
      });
      lanesRef.current = next;
      setLanes(next);
      setEventCount((c) => c + 1);
    };

    const markClosed = (id: string): void => {
      const lane = lanesRef.current.get(id);
      if (!lane) return;
      const next = new Map(lanesRef.current);
      next.set(id, { ...lane, run: { ...lane.run, status: "closed" } });
      lanesRef.current = next;
      setLanes(next);
    };

    const handle = openTheaterStream({
      workspaceId,
      runId,
      eventSourceFactory,
      onOpen: () => setStatus("live"),
      onError: () => setStatus("reconnecting"),
      onRun: upsertRun,
      onEvent: appendEvent,
      onDone: (info) => markClosed(info.runId),
    });
    return () => handle.close();
  }, [workspaceId, runId, eventSourceFactory]);

  const orderedLanes = useMemo<TheaterLane[]>(() => {
    return [...lanes.values()]
      .map((l) => ({ run: l.run, events: l.events, lastActivityMs: l.lastActivityMs }))
      .sort((a, b) => {
        // Open agents first, then the most recently active.
        const openDelta = Number(b.run.status === "open") - Number(a.run.status === "open");
        return openDelta !== 0 ? openDelta : b.lastActivityMs - a.lastActivityMs;
      });
  }, [lanes]);

  return { lanes: orderedLanes, status, eventCount };
}
