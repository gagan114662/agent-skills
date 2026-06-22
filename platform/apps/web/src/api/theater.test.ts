import { describe, it, expect, vi } from "vitest";
import { openTheaterStream, theaterStreamUrl, type EventSourceLike } from "./theater.js";

/**
 * Unit test for the live-theater SSE client (#624). jsdom ships no real `EventSource`, so a fake is
 * injected via `eventSourceFactory` — proving frame routing, the auto-close on `done`, and URL shape.
 */

class FakeEventSource implements EventSourceLike {
  url: string;
  closed = false;
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  private listeners = new Map<string, (ev: { data: string }) => void>();
  constructor(url: string) {
    this.url = url;
  }
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

describe("theaterStreamUrl", () => {
  it("targets the run stream when a runId is given, else the workspace fleet stream", () => {
    expect(theaterStreamUrl("w1", "run-1")).toBe("/workspaces/w1/traces/run-1/stream");
    expect(theaterStreamUrl("w1")).toBe("/workspaces/w1/traces/stream");
  });

  it("url-encodes ids", () => {
    expect(theaterStreamUrl("w 1", "r/2")).toBe("/workspaces/w%201/traces/r%2F2/stream");
  });
});

describe("openTheaterStream", () => {
  function setup() {
    let source: FakeEventSource | undefined;
    const onRun = vi.fn();
    const onEvent = vi.fn();
    const onDone = vi.fn();
    const onOpen = vi.fn();
    const onError = vi.fn();
    const handle = openTheaterStream({
      workspaceId: "w1",
      onRun,
      onEvent,
      onDone,
      onOpen,
      onError,
      eventSourceFactory: (url) => (source = new FakeEventSource(url)),
    });
    return { source: source!, handle, onRun, onEvent, onDone, onOpen, onError };
  }

  it("routes run / event frames to their handlers", () => {
    const { source, onRun, onEvent } = setup();
    source.emit("run", { id: "run-1", label: "Mark" });
    source.emit("event", { id: "e1", runId: "run-1", phase: "reasoning", summary: "thinking" });
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run-1" }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ phase: "reasoning" }));
  });

  it("closes the source when a done frame arrives", () => {
    const { source, onDone } = setup();
    source.emit("done", { runId: "run-1", eventCount: 3 });
    expect(onDone).toHaveBeenCalledWith({ runId: "run-1", eventCount: 3 });
    expect(source.closed).toBe(true);
  });

  it("surfaces open/error and ignores unparseable frames", () => {
    const { source, onOpen, onError, onEvent } = setup();
    source.onopen?.(null);
    source.onerror?.(null);
    // Feed a malformed frame through the listener openTheaterStream registered for "event".
    (source as unknown as { listeners: Map<string, (e: { data: string }) => void> }).listeners
      .get("event")?.({ data: "{not json" });
    expect(onOpen).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("close() is idempotent", () => {
    const { source, handle } = setup();
    handle.close();
    handle.close();
    expect(source.closed).toBe(true);
  });
});
