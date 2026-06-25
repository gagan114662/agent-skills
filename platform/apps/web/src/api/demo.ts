/**
 * Instant-demo / sandbox API client (issue #610) — the browser half of "type your URL, watch a real,
 * personalized marketing deliverable appear in seconds, with no account".
 *
 * The server generates the same #633 first-week growth teardown derived purely from the typed URL, but
 * the sandbox fetches it as ONE JSON document (`GET /onboarding/deliverable`) rather than over SSE: a
 * plain request is far more robust behind a CDN/preview proxy (which may buffer or rate-limit
 * `EventSource`), and it lets the standalone landing page run its own paced "watch it build" reveal. This
 * endpoint is PUBLIC and unauthenticated by design — a brand-new visitor has no session yet.
 *
 * The `fetch` is injectable (`fetchImpl`) so the client is unit-testable under jsdom without a network.
 */
import { apiUrl } from "./config.js";
import type { DeliverableBusinessDto } from "./deliverable.js";

/** One block of the deliverable. `kind` lets the UI badge/style it (insight vs. action vs. draft). */
export interface DemoSectionDto {
  id: string;
  kind: "insight" | "action" | "draft";
  heading: string;
  body: string;
}

/** The full artifact returned by the single-shot endpoint. Mirrors the server `DeliverablePlan`. */
export interface DemoDeliverableDto {
  business: DeliverableBusinessDto;
  title: string;
  subtitle: string;
  sections: DemoSectionDto[];
}

/** Minimal structural type satisfied by the browser `fetch` (so a fake works in tests). */
export interface FetchLike {
  (
    input: string,
    init?: { signal?: AbortSignal },
  ): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

/** Thrown when the demo can't be built. `badInput` distinguishes a 400 (bad URL) from a server/network fault. */
export class DemoError extends Error {
  readonly badInput: boolean;
  constructor(message: string, badInput: boolean) {
    super(message);
    this.name = "DemoError";
    this.badInput = badInput;
  }
}

/** Build the public single-shot URL for the demo deliverable from the typed website URL. */
export function demoDeliverableUrl(url: string): string {
  return apiUrl(`/onboarding/deliverable?url=${encodeURIComponent(url)}`);
}

/**
 * Fetch the personalized demo deliverable for a typed website URL. Returns the full artifact, or throws a
 * {@link DemoError} — `badInput: true` for a 400 (the visitor should fix their URL), `false` for any
 * server/network fault. The deliverable is server-sanitized text rendered downstream as React children.
 */
export async function fetchDemoDeliverable(
  url: string,
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<DemoDeliverableDto> {
  const doFetch: FetchLike =
    opts.fetchImpl ??
    ((input, init) => fetch(input, { credentials: "include", ...init }) as ReturnType<FetchLike>);

  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    res = await doFetch(demoDeliverableUrl(url), { signal: opts.signal });
  } catch {
    throw new DemoError("We couldn't reach the demo just now — please try again.", false);
  }

  if (!res.ok) {
    if (res.status === 400) {
      throw new DemoError("Enter a real website to see your demo — e.g. acme.com.", true);
    }
    throw new DemoError("Something went wrong building your demo — please try again.", false);
  }

  try {
    return (await res.json()) as DemoDeliverableDto;
  } catch {
    throw new DemoError("The demo service returned a non-JSON response — please try again.", false);
  }
}
