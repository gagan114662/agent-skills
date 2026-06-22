/**
 * Outcome-first deliverable SSE client (issue #633) — the browser half of "watch a real artifact appear
 * before you set anything up".
 *
 * The server generates a personalized first-week growth teardown from the typed URL alone and streams it
 * over Server-Sent Events (`routes/onboarding.ts`): a `start` header, one `section` frame at a time (paced
 * so it appears live), then `done`. This module opens that stream with `EventSource` and fans the named
 * frames out to typed handlers. The `EventSource` is injectable (`eventSourceFactory`) so the connection
 * logic is unit-testable in jsdom — which ships no real `EventSource` — with a fake.
 *
 * This stream is PUBLIC and unauthenticated by design: a brand-new visitor has no session yet.
 */
import { apiUrl } from "./config.js";

/** The business identity the server derived from the URL. Mirrors the server `DeliverableBusiness`. */
export interface DeliverableBusinessDto {
  url: string;
  host: string;
  name: string;
}

/** The header frame, announced once when the stream opens. */
export interface DeliverableStartDto {
  business: DeliverableBusinessDto;
  title: string;
  subtitle: string;
  sectionCount: number;
}

/** One streamed section of the deliverable. Mirrors the server `DeliverableSection` plus its order index. */
export interface DeliverableSectionDto {
  id: string;
  kind: "insight" | "action" | "draft";
  heading: string;
  body: string;
  index: number;
}

/** Terminal frame: the deliverable finished streaming. */
export interface DeliverableDoneDto {
  sectionCount: number;
}

/** Minimal structural type satisfied by the browser `EventSource` (so a fake works in tests). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
}

export interface DeliverableStreamHandlers {
  onStart?: (start: DeliverableStartDto) => void;
  onSection?: (section: DeliverableSectionDto) => void;
  onDone?: (info: DeliverableDoneDto) => void;
  onOpen?: () => void;
  onError?: () => void;
}

export interface DeliverableStreamOptions extends DeliverableStreamHandlers {
  /** The website URL the visitor typed (bare domain or full URL — the server normalizes it). */
  url: string;
  eventSourceFactory?: (url: string) => EventSourceLike;
}

export interface DeliverableStreamHandle {
  close(): void;
}

function defaultFactory(url: string): EventSourceLike {
  // withCredentials is a no-op same-origin; harmless on the public route, and correct for a split deploy.
  return new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;
}

/** Build the SSE URL for a deliverable stream from the typed website URL. */
export function deliverableStreamUrl(url: string): string {
  return apiUrl(`/onboarding/deliverable/stream?url=${encodeURIComponent(url)}`);
}

function parse<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * Open a live deliverable stream. Returns a handle whose `close()` tears the connection down (idempotent).
 * Unparseable frames are ignored; the `done` frame closes the source automatically.
 */
export function openDeliverableStream(options: DeliverableStreamOptions): DeliverableStreamHandle {
  const { url, eventSourceFactory, ...handlers } = options;
  const factory = eventSourceFactory ?? defaultFactory;
  const source = factory(deliverableStreamUrl(url));
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.addEventListener("start", (ev) => {
    const start = parse<DeliverableStartDto>(ev.data);
    if (start) handlers.onStart?.(start);
  });
  source.addEventListener("section", (ev) => {
    const section = parse<DeliverableSectionDto>(ev.data);
    if (section) handlers.onSection?.(section);
  });
  source.addEventListener("done", (ev) => {
    const info = parse<DeliverableDoneDto>(ev.data);
    if (info) handlers.onDone?.(info);
    close();
  });
  source.onopen = (): void => handlers.onOpen?.();
  source.onerror = (): void => handlers.onError?.();

  return { close };
}
