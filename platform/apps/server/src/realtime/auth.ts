import type { IncomingHttpHeaders } from "node:http";
import type { Credentials } from "../auth/middleware.js";
import { SESSION_COOKIE } from "../auth/middleware.js";

/** The subset of a Node upgrade request the credential extractor needs. */
export interface UpgradeRequestLike {
  headers: IncomingHttpHeaders;
  url?: string | undefined;
}

/** Parse a `Cookie` header into a name→value map. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

/**
 * Extract auth credentials from a WebSocket upgrade request so the gateway can reuse
 * the REST identity resolver (#3). Browsers can't set headers on a `WebSocket`, so we
 * also accept query params:
 *   - agents:  `Authorization: Bearer …` header, or `?access_token=…`
 *   - humans:  `rid` cookie, or `?rid=…`
 * Header/cookie take precedence over query params.
 */
export function extractWsCredentials(req: UpgradeRequestLike): Credentials {
  // `req.url` on an upgrade request is path-only (e.g. "/ws?access_token=…"); the host is
  // irrelevant to parsing, so a placeholder base is fine.
  const query = new URL(req.url ?? "/", "http://localhost").searchParams;

  const headerAuthz = req.headers.authorization;
  const queryToken = query.get("access_token");
  const authorization =
    headerAuthz ?? (queryToken ? `Bearer ${queryToken}` : undefined);

  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies[SESSION_COOKIE] ?? query.get("rid") ?? undefined;

  return { authorization, sessionToken };
}
