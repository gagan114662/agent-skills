import { describe, it, expect, vi } from "vitest";
import {
  openDeliverableStream,
  deliverableStreamUrl,
  type EventSourceLike,
} from "./deliverable.js";

/**
 * Unit test for the #633 outcome-first deliverable SSE client. jsdom ships no real `EventSource`, so a fake
 * is injected via `eventSourceFactory` — proving frame routing, the auto-close on `done`, and URL shape.
 */

class FakeEventSource implements EventSourceLike {
  url: string;
  closed = false;
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  listeners = new Map<string, (ev: { data: string }) => void>();
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

describe("deliverableStreamUrl", () => {
  it("targets the public stream and url-encodes the typed url", () => {
    expect(deliverableStreamUrl("acme.com")).toBe("/onboarding/deliverable/stream?url=acme.com");
    expect(deliverableStreamUrl("https://a.com/x?y=1")).toBe(
      "/onboarding/deliverable/stream?url=https%3A%2F%2Fa.com%2Fx%3Fy%3D1",
    );
  });
});

describe("openDeliverableStream", () => {
  function setup() {
    let source: FakeEventSource | undefined;
    const onStart = vi.fn();
    const onSection = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const handle = openDeliverableStream({
      url: "acme.com",
      onStart,
      onSection,
      onDone,
      onError,
      eventSourceFactory: (url) => (source = new FakeEventSource(url)),
    });
    return { source: source!, handle, onStart, onSection, onDone, onError };
  }

  it("routes start / section frames to their handlers", () => {
    const { source, onStart, onSection } = setup();
    source.emit("start", { title: "Acme's teardown", sectionCount: 2 });
    source.emit("section", { id: "snapshot", kind: "insight", heading: "X", body: "y", index: 0 });
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ title: "Acme's teardown" }));
    expect(onSection).toHaveBeenCalledWith(expect.objectContaining({ kind: "insight", index: 0 }));
  });

  it("closes the source when a done frame arrives", () => {
    const { source, onDone } = setup();
    source.emit("done", { sectionCount: 6 });
    expect(onDone).toHaveBeenCalledWith({ sectionCount: 6 });
    expect(source.closed).toBe(true);
  });

  it("surfaces error and ignores unparseable frames", () => {
    const { source, onError, onSection } = setup();
    source.onerror?.(null);
    source.listeners.get("section")?.({ data: "{not json" });
    expect(onError).toHaveBeenCalled();
    expect(onSection).not.toHaveBeenCalled();
  });

  it("close() is idempotent", () => {
    const { source, handle } = setup();
    handle.close();
    handle.close();
    expect(source.closed).toBe(true);
  });
});
