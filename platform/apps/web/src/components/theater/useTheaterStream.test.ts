import { describe, it, expect, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTheaterStream, LANE_EVENT_CAP } from "./useTheaterStream.js";
import type { EventSourceLike, TheaterEventDto, TheaterRunDto } from "../../api/theater.js";

/** Unit test for the theater accumulation hook (#624) — driven by a fake injected EventSource. */

class FakeSource implements EventSourceLike {
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  closed = false;
  private listeners = new Map<string, (ev: { data: string }) => void>();
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

let current: FakeSource | undefined;
const factory = (): EventSourceLike => (current = new FakeSource());

afterEach(() => {
  current = undefined;
});

function run(over: Partial<TheaterRunDto> & { id: string }): TheaterRunDto {
  return {
    workspaceId: "w1",
    sessionId: null,
    agentMemberId: null,
    taskId: null,
    label: over.label ?? null,
    status: "open",
    eventCount: 0,
    startedAt: "2026-06-22T00:00:00.000Z",
    endedAt: null,
    ...over,
  };
}

function ev(over: Partial<TheaterEventDto> & { id: string; runId: string; seq: number }): TheaterEventDto {
  return {
    turn: 0,
    type: "model_response",
    phase: "reasoning",
    label: null,
    summary: "thinking",
    occurredAt: "2026-06-22T00:00:00.000Z",
    ...over,
  };
}

describe("useTheaterStream", () => {
  it("is inert without a workspace id", () => {
    const { result } = renderHook(() => useTheaterStream(undefined, undefined, factory));
    expect(result.current.status).toBe("idle");
    expect(result.current.lanes).toEqual([]);
    expect(current).toBeUndefined();
  });

  it("builds a lane per run and appends its events in order", () => {
    const { result } = renderHook(() => useTheaterStream("w1", undefined, factory));
    act(() => current!.onopen?.(null));
    act(() => current!.emit("run", run({ id: "r1", label: "Mark" })));
    act(() => current!.emit("event", ev({ id: "e1", runId: "r1", seq: 1, summary: "draft post" })));
    act(() =>
      current!.emit("event", ev({ id: "e2", runId: "r1", seq: 2, phase: "action", summary: "publish" })),
    );

    expect(result.current.status).toBe("live");
    expect(result.current.lanes).toHaveLength(1);
    expect(result.current.lanes[0]!.run.label).toBe("Mark");
    expect(result.current.lanes[0]!.events.map((e) => e.summary)).toEqual(["draft post", "publish"]);
    expect(result.current.eventCount).toBe(2);
  });

  it("de-duplicates a re-sent event (reconnect tail) by id", () => {
    const { result } = renderHook(() => useTheaterStream("w1", undefined, factory));
    act(() => current!.emit("event", ev({ id: "e1", runId: "r1", seq: 1 })));
    act(() => current!.emit("event", ev({ id: "e1", runId: "r1", seq: 1 })));
    expect(result.current.lanes[0]!.events).toHaveLength(1);
    expect(result.current.eventCount).toBe(1);
  });

  it("orders open agents before done ones", () => {
    const { result } = renderHook(() => useTheaterStream("w1", undefined, factory));
    act(() => current!.emit("run", run({ id: "r1", label: "A", status: "open" })));
    act(() => current!.emit("event", ev({ id: "a1", runId: "r1", seq: 1, occurredAt: "2026-06-22T00:00:01.000Z" })));
    act(() => current!.emit("run", run({ id: "r2", label: "B", status: "open" })));
    act(() => current!.emit("event", ev({ id: "b1", runId: "r2", seq: 1, occurredAt: "2026-06-22T00:00:05.000Z" })));
    // r1 finishes — it should drop below the still-open r2.
    act(() => current!.emit("done", { runId: "r1", eventCount: 1 }));

    const ids = result.current.lanes.map((l) => l.run.id);
    expect(ids[0]).toBe("r2");
    expect(result.current.lanes.find((l) => l.run.id === "r1")!.run.status).toBe("closed");
  });

  it("caps a lane's retained events", () => {
    const { result } = renderHook(() => useTheaterStream("w1", undefined, factory));
    act(() => {
      for (let i = 1; i <= LANE_EVENT_CAP + 25; i++) {
        current!.emit("event", ev({ id: `e${i}`, runId: "r1", seq: i }));
      }
    });
    expect(result.current.lanes[0]!.events).toHaveLength(LANE_EVENT_CAP);
    // The oldest were dropped; the newest is retained.
    expect(result.current.lanes[0]!.events.at(-1)!.id).toBe(`e${LANE_EVENT_CAP + 25}`);
  });

  it("closes the source on unmount", () => {
    const { unmount } = renderHook(() => useTheaterStream("w1", undefined, factory));
    const src = current!;
    unmount();
    expect(src.closed).toBe(true);
  });

  it("marks reconnecting on error", () => {
    const { result } = renderHook(() => useTheaterStream("w1", undefined, factory));
    act(() => current!.onerror?.(null));
    expect(result.current.status).toBe("reconnecting");
  });
});
