import type { PreviewAnnotation } from "@reload/shared";

/**
 * Pure port/URL detection for the Run tab (#56). `RunProcessManager` feeds each line of a dev
 * server's output here; the first line that looks like a bound localhost address yields the preview
 * URL. Kept pure + side-effect-free so it is exhaustively unit-testable.
 *
 * Every pattern is **bounded** (no nested quantifiers, capped `\d{1,5}` / `.{0,40}`) so a hostile or
 * runaway log line cannot trigger catastrophic backtracking (ReDoS) — detection must never let a
 * chatty child process stall the event loop.
 */

/** A scheme-qualified localhost/loopback URL: `http(s)://localhost|127.0.0.1|0.0.0.0:PORT`. */
const SCHEME_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})/i;
/** A "listening/running/ready … port N" phrase (frameworks that print no URL). */
const PORT_PHRASE = /(?:listening|running|ready|started).{0,40}?\bport\b[:\s]+(\d{1,5})/i;
/** A bare `host:port` with no scheme. */
const BARE_HOSTPORT = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})\b/i;

/** Build the canonical preview URL for a port (always `localhost`), or null if out of TCP range. */
function urlForPort(port: string): string | null {
  const n = Number(port);
  return n >= 1 && n <= 65535 ? `http://localhost:${port}` : null;
}

/**
 * Detect a preview URL in one output line, or `null` if the line carries no bound address.
 *
 * When `pattern` is supplied it overrides the defaults: its **first capture group** must hold either
 * a port number (→ `http://localhost:<port>`) or a full URL (returned as-is). A malformed custom
 * pattern is ignored (falls back to the default scan) rather than throwing.
 */
export function detectUrl(line: string, pattern?: string): string | null {
  if (pattern) {
    try {
      const m = new RegExp(pattern).exec(line);
      if (m?.[1]) {
        const g = m[1];
        if (/^\d{1,5}$/.test(g)) return urlForPort(g);
        if (/^https?:\/\//i.test(g)) return g;
        return null;
      }
      // Pattern matched but captured nothing usable → fall through to the default scan.
    } catch {
      /* invalid user-supplied regex → ignore, use defaults */
    }
  }
  const m = SCHEME_URL.exec(line) ?? PORT_PHRASE.exec(line) ?? BARE_HOSTPORT.exec(line);
  return m?.[1] ? urlForPort(m[1]) : null;
}

/** Format a normalized fraction (0–1) as a whole-percent string, e.g. `0.34 → "34%"`. */
function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/**
 * Render preview annotations (#56) into a task string for the follow-up agent session — the same
 * round trip as #51 review comments, but anchored to spots on the running UI rather than diff lines.
 * Coordinates are normalized so the agent gets a stable "top-left / center" description.
 */
export function formatAnnotationsTask(annotations: PreviewAnnotation[]): string {
  const url = annotations.find((a) => a.pageUrl)?.pageUrl ?? "the running preview";
  const lines = annotations.map((a) => {
    const pos = `(${pct(a.x)}, ${pct(a.y)})`;
    const size =
      a.width !== undefined && a.height !== undefined ? ` [${pct(a.width)}×${pct(a.height)}]` : "";
    return `- ${pos}${size} — ${a.note}`;
  });
  return `The user annotated the running preview at ${url}. Address each note, then commit the fixes:\n${lines.join(
    "\n",
  )}`;
}
