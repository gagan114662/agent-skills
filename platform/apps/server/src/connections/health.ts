import {
  GOOGLE_ANALYTICS_SCOPE,
  GOOGLE_SEARCH_CONSOLE_SCOPE,
} from "../auth/google-oauth.js";
import type { ConnectionDescriptor } from "./registry.js";

export type ConnectionHealthProof =
  | {
      ok: true;
      provider: string;
      checkedAtMs: number;
      scopes: string[];
      subject: string | null;
      audience: string | null;
    }
  | { ok: false; provider: string; reason: string };

const GOOGLE_TOKENINFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo";
const X_USERS_ME_ENDPOINT = "https://api.x.com/2/users/me";

function parseScopes(value: unknown): string[] {
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}

function requiredScopes(descriptor: ConnectionDescriptor): string[] {
  if (descriptor.id !== "google") return descriptor.oauthScopes;
  return [GOOGLE_SEARCH_CONSOLE_SCOPE, GOOGLE_ANALYTICS_SCOPE];
}

async function verifyGoogleConnectionHealth(
  descriptor: ConnectionDescriptor,
  secrets: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<ConnectionHealthProof> {
  const token = secrets.GOOGLE_OAUTH_ACCESS_TOKEN?.trim();
  if (!token) return { ok: false, provider: descriptor.provider, reason: "missing Google access token" };

  let res: Response;
  try {
    const url = new URL(GOOGLE_TOKENINFO_ENDPOINT);
    url.searchParams.set("access_token", token);
    res = await fetchImpl(url, { method: "GET" });
  } catch (err) {
    return {
      ok: false,
      provider: descriptor.provider,
      reason: `Google token health check failed: ${(err as Error).message}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      provider: descriptor.provider,
      reason: `Google token health check returned ${res.status}`,
    };
  }

  const json = (await res.json()) as { scope?: unknown; sub?: unknown; aud?: unknown };
  const scopes = parseScopes(json.scope);
  const missing = requiredScopes(descriptor).filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) {
    return {
      ok: false,
      provider: descriptor.provider,
      reason: `Google token is missing required scopes: ${missing.join(", ")}`,
    };
  }

  return {
    ok: true,
    provider: descriptor.provider,
    checkedAtMs: Date.now(),
    scopes,
    subject: typeof json.sub === "string" && json.sub.trim() ? json.sub : null,
    audience: typeof json.aud === "string" && json.aud.trim() ? json.aud : null,
  };
}

async function verifyXConnectionHealth(
  descriptor: ConnectionDescriptor,
  secrets: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<ConnectionHealthProof> {
  const token = secrets.X_OAUTH_ACCESS_TOKEN?.trim();
  if (!token) return { ok: false, provider: descriptor.provider, reason: "missing X access token" };

  const scopes = parseScopes(secrets.X_OAUTH_SCOPE);
  const missing = requiredScopes(descriptor).filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) {
    return {
      ok: false,
      provider: descriptor.provider,
      reason: `X token is missing required scopes: ${missing.join(", ")}`,
    };
  }

  let res: Response;
  try {
    res = await fetchImpl(X_USERS_ME_ENDPOINT, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return {
      ok: false,
      provider: descriptor.provider,
      reason: `X token health check failed: ${(err as Error).message}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      provider: descriptor.provider,
      reason: `X token health check returned ${res.status}`,
    };
  }

  const json = (await res.json()) as { data?: { id?: unknown; username?: unknown } };
  const subject = typeof json.data?.id === "string" && json.data.id.trim() ? json.data.id : null;
  if (!subject) return { ok: false, provider: descriptor.provider, reason: "X health check returned no user id" };

  return {
    ok: true,
    provider: descriptor.provider,
    checkedAtMs: Date.now(),
    scopes,
    subject,
    audience: typeof json.data?.username === "string" && json.data.username.trim() ? json.data.username : null,
  };
}

/**
 * Provider readback before a connector is marked healthy (#1285). A token exchange is not enough: the
 * callback must prove the credential can still be introspected and carries the scopes the agents need.
 */
export async function verifyConnectionHealth(input: {
  descriptor: ConnectionDescriptor;
  secrets: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<ConnectionHealthProof> {
  if (input.descriptor.id === "google") {
    return verifyGoogleConnectionHealth(input.descriptor, input.secrets, input.fetchImpl ?? fetch);
  }
  if (input.descriptor.id === "x") {
    return verifyXConnectionHealth(input.descriptor, input.secrets, input.fetchImpl ?? fetch);
  }
  return {
    ok: false,
    provider: input.descriptor.provider,
    reason: `No provider health check is wired for ${input.descriptor.id}`,
  };
}
