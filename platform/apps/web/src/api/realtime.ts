/**
 * WebSocket client for the Reload `/ws` gateway.
 *
 * Responsibilities:
 *  - open the socket same-origin (the `rid` cookie is sent automatically on the upgrade)
 *  - track the set of subscribed channels and (re-)send `subscribe` on every (re)connect
 *  - auto-reconnect with capped exponential backoff after an unexpected close
 *  - fan incoming `ServerEvent`s out to registered listeners
 *
 * The socket is injectable (`socketFactory`) so the reconnect/subscribe logic is unit-testable
 * without a real network.
 */
import type { ClientCommand, ServerEvent } from "./types.js";
import { wsUrl } from "./config.js";

/** Minimal structural type satisfied by the browser `WebSocket`. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface RealtimeOptions {
  url?: string;
  socketFactory?: (url: string) => RealtimeSocket;
  /** Base reconnect delay; doubles each attempt up to a cap. */
  reconnectDelayMs?: number;
}

export interface Realtime {
  connect(): void;
  close(): void;
  subscribe(channelId: string): void;
  unsubscribe(channelId: string): void;
  presence(status: "online" | "away"): void;
  on(listener: (event: ServerEvent) => void): () => void;
}

function defaultUrl(): string {
  return wsUrl("/ws");
}

function defaultFactory(url: string): RealtimeSocket {
  return new WebSocket(url) as unknown as RealtimeSocket;
}

const MAX_RECONNECT_DELAY_MS = 10_000;

export function createRealtime(options: RealtimeOptions = {}): Realtime {
  const url = options.url ?? defaultUrl();
  const factory = options.socketFactory ?? defaultFactory;
  const baseDelay = options.reconnectDelayMs ?? 1_000;

  const subscriptions = new Set<string>();
  const listeners = new Set<(event: ServerEvent) => void>();
  let socket: RealtimeSocket | null = null;
  let open = false;
  let intentionallyClosed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function emit(event: ServerEvent): void {
    for (const l of listeners) l(event);
  }

  function rawSend(command: ClientCommand): void {
    if (open && socket) socket.send(JSON.stringify(command));
  }

  function scheduleReconnect(): void {
    if (intentionallyClosed) return;
    const delay = Math.min(baseDelay * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
    attempt += 1;
    reconnectTimer = setTimeout(openSocket, delay);
  }

  function openSocket(): void {
    socket = factory(url);
    socket.onopen = (): void => {
      open = true;
      attempt = 0;
      // Re-establish every tracked subscription on (re)connect.
      for (const channelId of subscriptions) rawSend({ type: "subscribe", channelId });
    };
    socket.onmessage = (ev): void => {
      try {
        emit(JSON.parse(ev.data) as ServerEvent);
      } catch {
        // Ignore unparseable frames — the gateway only sends JSON.
      }
    };
    socket.onclose = (): void => {
      open = false;
      socket = null;
      scheduleReconnect();
    };
    socket.onerror = (): void => {
      // Close handling drives reconnect; errors are advisory.
    };
  }

  return {
    connect(): void {
      intentionallyClosed = false;
      if (!socket) openSocket();
    },
    close(): void {
      intentionallyClosed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      open = false;
      socket?.close();
      socket = null;
    },
    subscribe(channelId: string): void {
      subscriptions.add(channelId);
      rawSend({ type: "subscribe", channelId });
    },
    unsubscribe(channelId: string): void {
      subscriptions.delete(channelId);
      rawSend({ type: "unsubscribe", channelId });
    },
    presence(status: "online" | "away"): void {
      rawSend({ type: "presence", status });
    },
    on(listener: (event: ServerEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
