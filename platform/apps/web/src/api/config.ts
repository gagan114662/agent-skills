/**
 * Resolves the API origin the web console talks to.
 *
 * Same-origin (local dev via the Vite proxy, or a single-origin production deploy): leave
 * `VITE_API_BASE_URL` unset — every request stays server-relative ("/me", "/ws") and the
 * httpOnly `rid` session cookie rides along automatically.
 *
 * Split deployment (web on Vercel, API on a separate always-on host — #108): set
 * `VITE_API_BASE_URL` to the API origin (e.g. "https://api.ipop.ai") at build time. REST calls
 * and the WebSocket are then sent cross-origin. The live ipop.ai domains also resolve to
 * `api.ipop.ai` at runtime as a guardrail against a stale/missing Vercel env var.
 *
 * NOTE: cross-origin auth requires the server to set the session cookie with `SameSite=None;
 * Secure` and to allow-list this web origin for credentialed CORS. See docs/guides/ipop-deploy.md.
 */
const CONFIGURED_API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";
const IPOPAI_PRODUCTION_API_BASE_URL = "https://api.ipop.ai";
const IPOPAI_WEB_HOSTS = new Set(["ipop.ai", "www.ipop.ai"]);

type RuntimeLocation = {
  configuredBaseUrl?: string;
  hostname?: string;
  protocol?: string;
  host?: string;
};

function trimBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").replace(/\/+$/, "");
}

function browserLocation(): RuntimeLocation {
  if (typeof window === "undefined") return {};
  return {
    hostname: window.location.hostname,
    protocol: window.location.protocol,
    host: window.location.host,
  };
}

export function resolveApiBaseUrl(location: RuntimeLocation = {}): string {
  const configured = trimBaseUrl(location.configuredBaseUrl ?? CONFIGURED_API_BASE_URL);
  if (configured) return configured;

  const hostname = location.hostname ?? browserLocation().hostname;
  if (hostname && IPOPAI_WEB_HOSTS.has(hostname.toLowerCase())) return IPOPAI_PRODUCTION_API_BASE_URL;

  return "";
}

export const API_BASE_URL: string = resolveApiBaseUrl();

/** Prefix a server-relative path with the configured API origin (no-op when same-origin). */
export function apiUrl(path: string): string {
  const baseUrl = resolveApiBaseUrl();
  return baseUrl ? `${baseUrl}${path}` : path;
}

/** Derive the WebSocket URL for the `/ws` gateway, honoring the configured API origin. */
export function resolveWsUrl(path = "/ws", location: RuntimeLocation = {}): string {
  const baseUrl = resolveApiBaseUrl(location);
  if (baseUrl) {
    // "https://api.ipop.ai" -> "wss://api.ipop.ai"; "http://..." -> "ws://..."
    return `${baseUrl.replace(/^http/, "ws")}${path}`;
  }

  const current = { ...browserLocation(), ...location };
  if (!current.host) return `ws://localhost${path}`;
  const proto = current.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${current.host}${path}`;
}

/** Derive the WebSocket URL for the `/ws` gateway, honoring the configured API origin. */
export function wsUrl(path = "/ws"): string {
  return resolveWsUrl(path);
}
