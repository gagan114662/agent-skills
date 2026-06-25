import type { LinkedInSender } from "./linkedin.js";

/**
 * Permitted-API LinkedIn sender (#856). This calls a configured LinkedIn Messaging/API gateway using a
 * tenant-scoped #192 vault token. It is not browser automation and it never drives the LinkedIn UI.
 */

export interface LinkedInApiFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type LinkedInApiFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<LinkedInApiFetchResponse>;

export interface LinkedInApiSenderOptions {
  token: string;
  baseUrl: string;
  fetchImpl?: LinkedInApiFetch;
}

function cleanBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function externalIdFrom(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  for (const key of ["externalId", "id", "messageId", "urn"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function createLinkedInApiSender(opts: LinkedInApiSenderOptions): LinkedInSender {
  const token = opts.token.trim();
  const baseUrl = cleanBaseUrl(opts.baseUrl);
  const fetchImpl: LinkedInApiFetch =
    opts.fetchImpl ??
    (async (url, init) => {
      const res = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      return { ok: res.ok, status: res.status, json: () => res.json() };
    });

  return {
    kind: "linkedin-api",
    async send(input) {
      if (!token) throw new Error("missing LinkedIn API token");
      if (!baseUrl) throw new Error("missing LinkedIn API base URL");
      const res = await fetchImpl(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ to: input.to, body: input.body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`LinkedIn API returned ${res.status}`);
      const externalId = externalIdFrom(json);
      if (!externalId) throw new Error("LinkedIn API response missing external id");
      return { externalId };
    },
  };
}
