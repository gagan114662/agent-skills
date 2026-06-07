import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRealtime, type RealtimeSocket } from "./realtime.js";
import type { ServerEvent } from "./types.js";

/** A controllable fake socket so tests can drive open/message/close deterministically. */
class FakeSocket implements RealtimeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  // --- test helpers ---
  open(): void {
    this.onopen?.();
  }
  emit(event: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

let sockets: FakeSocket[];
const factory = (_url: string): RealtimeSocket => {
  const s = new FakeSocket();
  sockets.push(s);
  return s;
};

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("realtime client", () => {
  it("flushes queued subscriptions once the socket opens", () => {
    const rt = createRealtime({ socketFactory: factory, reconnectDelayMs: 10 });
    rt.connect();
    rt.subscribe("c1"); // queued before open

    expect(sockets[0]!.sent).toEqual([]); // nothing sent until open
    sockets[0]!.open();

    expect(sockets[0]!.sent.map((s) => JSON.parse(s))).toContainEqual({
      type: "subscribe",
      channelId: "c1",
    });
  });

  it("dispatches parsed server events to listeners", () => {
    const rt = createRealtime({ socketFactory: factory });
    const events: ServerEvent[] = [];
    rt.on((e) => events.push(e));
    rt.connect();
    sockets[0]!.open();

    const msgEvent: ServerEvent = {
      type: "message",
      message: {
        id: "m1",
        channelId: "c1",
        authorMemberId: "u1",
        parentMessageId: null,
        alsoSentToChannel: false,
        body: "hi",
      },
    };
    sockets[0]!.emit(msgEvent);

    expect(events).toContainEqual(msgEvent);
  });

  it("reconnects after an unexpected close and re-subscribes tracked channels", () => {
    const rt = createRealtime({ socketFactory: factory, reconnectDelayMs: 10 });
    rt.connect();
    sockets[0]!.open();
    rt.subscribe("c1");

    // server drops the connection
    sockets[0]!.onclose?.();
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(10); // backoff elapses → new socket created
    expect(sockets).toHaveLength(2);

    sockets[1]!.open();
    expect(sockets[1]!.sent.map((s) => JSON.parse(s))).toContainEqual({
      type: "subscribe",
      channelId: "c1",
    });
  });

  it("does not reconnect after an explicit close()", () => {
    const rt = createRealtime({ socketFactory: factory, reconnectDelayMs: 10 });
    rt.connect();
    sockets[0]!.open();
    rt.close();

    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(1);
  });
});
