/**
 * Resolves the API origin the web console talks to.
 *
 * Same-origin (local dev via the Vite proxy, or a single-origin production deploy): leave
 * `VITE_API_BASE_URL` unset — every request stays server-relative ("/me", "/ws") and the
 * httpOnly `rid` session cookie rides along automatically.
 *
 * Split deployment (web on Vercel, API on a separate always-on host — #108): set
 * `VITE_API_BASE_URL` to the API origin (e.g. "https://api.ipop.ai") at build time. REST calls
 * and the WebSocket are then sent cross-origin.
 *
 * NOTE: cross-origin auth requires the server to set the session cookie with `SameSite=None;
 * Secure` and to allow-list this web origin for credentialed CORS. See docs/guides/ipop-deploy.md.
 */
export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

/** Prefix a server-relative path with the configured API origin (no-op when same-origin). */
export function apiUrl(path: string): string {
  return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}

/** Derive the WebSocket URL for the `/ws` gateway, honoring the configured API origin. */
export function wsUrl(path = "/ws"): string {
  if (API_BASE_URL) {
    // "https://api.ipop.ai" -> "wss://api.ipop.ai"; "http://..." -> "ws://..."
    return `${API_BASE_URL.replace(/^http/, "ws")}${path}`;
  }
  if (typeof window === "undefined") return `ws://localhost${path}`;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}
