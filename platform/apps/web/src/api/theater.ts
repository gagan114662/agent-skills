/**
 * Live-theater SSE client (issue #624) — the browser half of the "watch the agents work" stream.
 *
 * The server projects each agent run's trace into a live feed of reasoning → action → artifact and pushes
 * it over Server-Sent Events (`routes/traces.ts`). This module opens that stream with `EventSource` (the
 * `rid` session cookie rides along same-origin; cross-origin uses `withCredentials`) and fans the named
 * frames out to typed handlers. The `EventSource` is injectable (`eventSourceFactory`) so the connection
 * logic is unit-testable in jsdom — which ships no real `EventSource` — with a fake.
 */
import { apiUrl } from "./config.js";

/** The watchable phase of a streamed event — mirrors the server's `TheaterPhase`. */
export type TheaterPhase = "context" | "reasoning" | "action" | "artifact" | "approval";

/** One streamed trace event, projected for the theater. Mirrors the server `TheaterEvent`. */
export interface TheaterEventDto {
  id: string;
  runId: string;
  seq: number;
  turn: number;
  type: string;
  phase: TheaterPhase;
  label: string | null;
  summary: string;
  occurredAt: string;
}

/** The run header announced when a run is first seen on a stream. Dates arrive as ISO strings. */
export interface TheaterRunDto {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  agentMemberId: string | null;
  taskId: string | null;
  label: string | null;
  status: "open" | "closed";
  eventCount: number;
  startedAt: string;
  endedAt: string | null;
}

/** Terminal frame for a single-run stream: the run finished (or was absent). */
export interface TheaterDoneDto {
  runId: string;
  eventCount: number;
}

/** Minimal structural type satisfied by the browser `EventSource` (so a fake works in tests). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
}

export interface TheaterStreamHandlers {
  onRun?: (run: TheaterRunDto) => void;
  onEvent?: (event: TheaterEventDto) => void;
  onDone?: (info: TheaterDoneDto) => void;
  onOpen?: () => void;
  onError?: () => void;
}

export interface TheaterStreamOptions extends TheaterStreamHandlers {
  workspaceId: string;
  /** Focus a single run; omit to watch the whole workspace fleet. */
  runId?: string;
  eventSourceFactory?: (url: string) => EventSourceLike;
}

export interface TheaterStreamHandle {
  close(): void;
}

function defaultFactory(url: string): EventSourceLike {
  // withCredentials sends the session cookie cross-origin (#108 split deploy); a no-op same-origin.
  return new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;
}

/** Build the SSE URL for a run (single-run theater) or a whole workspace (fleet theater). */
export function theaterStreamUrl(workspaceId: string, runId?: string): string {
  const w = encodeURIComponent(workspaceId);
  return runId
    ? apiUrl(`/workspaces/${w}/traces/${encodeURIComponent(runId)}/stream`)
    : apiUrl(`/workspaces/${w}/traces/stream`);
}

function parse<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * Open a live theater stream. Returns a handle whose `close()` tears the connection down (idempotent).
 * Unparseable frames are ignored; a single-run stream's `done` frame closes the source automatically.
 */
export function openTheaterStream(options: TheaterStreamOptions): TheaterStreamHandle {
  const { workspaceId, runId, eventSourceFactory, ...handlers } = options;
  const factory = eventSourceFactory ?? defaultFactory;
  const source = factory(theaterStreamUrl(workspaceId, runId));
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.addEventListener("run", (ev) => {
    const run = parse<TheaterRunDto>(ev.data);
    if (run) handlers.onRun?.(run);
  });
  source.addEventListener("event", (ev) => {
    const event = parse<TheaterEventDto>(ev.data);
    if (event) handlers.onEvent?.(event);
  });
  source.addEventListener("done", (ev) => {
    const info = parse<TheaterDoneDto>(ev.data);
    if (info) handlers.onDone?.(info);
    close();
  });
  source.onopen = (): void => handlers.onOpen?.();
  source.onerror = (): void => handlers.onError?.();

  return { close };
}
