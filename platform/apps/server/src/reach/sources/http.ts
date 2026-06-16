import {
  ProspectSourceUnavailableError,
  type ProspectSearchInput,
  type ProspectSearchResult,
  type ProspectSource,
} from "../prospect-source.js";
import { contactKey } from "../score.js";
import type { ProspectSourceKind, RawProspect } from "../types.js";

/**
 * Generic HTTP prospect source (#280) — the shared engine behind the paid data adapters (Clay / Lusha /
 * Vibe). They are all "call a permitted API with a vault key, map JSON → prospects"; only the request
 * shape, the response mapping, and the price differ, so those are the only per-provider config. NO
 * scraping: a provider only ever issues an authenticated API call. The API key is loaded from the #192
 * vault through `loadApiKey` and is NEVER logged or echoed (the adapter only ever puts it in a header).
 */

/** Minimal response shape we depend on — keeps the adapter independent of the DOM `fetch` typings. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Minimal fetch seam — the real `fetch` satisfies it; tests inject a canned implementation. */
export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

export interface HttpProspectSourceConfig {
  kind: ProspectSourceKind;
  /** Cost per prospect, in cents — the basis for the money-gate estimate. */
  costPerProspectCents: number;
  /** Build the authenticated request for a search. */
  buildRequest(
    input: ProspectSearchInput,
    apiKey: string,
  ): { url: string; method: string; headers: Record<string, string>; body?: string };
  /** Map the provider's JSON response into structured prospects (untrusted text stays in `signals`). */
  mapResponse(json: unknown): RawProspect[];
}

export interface HttpProspectSourceDeps {
  /** Loads the provider API key from the #192 vault for this workspace, or null when not connected. */
  loadApiKey: () => Promise<string | null>;
  httpFetch: HttpFetch;
}

export function createHttpProspectSource(
  config: HttpProspectSourceConfig,
  deps: HttpProspectSourceDeps,
): ProspectSource {
  return {
    kind: config.kind,
    paid: true,
    estimateCostCents: (limit: number) => Math.max(0, Math.trunc(config.costPerProspectCents * limit)),
    async search(input: ProspectSearchInput): Promise<ProspectSearchResult> {
      const apiKey = await deps.loadApiKey();
      if (!apiKey) {
        // No credential in the vault — the service treats this as "queue, don't fake". Never a crash.
        throw new ProspectSourceUnavailableError(
          config.kind,
          `${config.kind} is not connected (no API key in the vault)`,
        );
      }
      const req = config.buildRequest(input, apiKey);
      let res: HttpResponse;
      try {
        res = await deps.httpFetch(req.url, { method: req.method, headers: req.headers, body: req.body });
      } catch (err) {
        throw new ProspectSourceUnavailableError(
          config.kind,
          `${config.kind} request failed: ${err instanceof Error ? err.message : "unknown error"}`,
        );
      }
      if (!res.ok) {
        throw new ProspectSourceUnavailableError(config.kind, `${config.kind} returned HTTP ${res.status}`);
      }
      const mapped = config.mapResponse(await res.json());
      // Honour excludeKeys (already contacted) and the limit; only bill for what we keep.
      const fresh: RawProspect[] = [];
      for (const p of mapped) {
        if (input.excludeKeys.has(contactKey(p))) continue;
        fresh.push(p);
        if (fresh.length >= input.limit) break;
      }
      return {
        prospects: fresh,
        provider: config.kind,
        creditsCents: Math.max(0, Math.trunc(config.costPerProspectCents * fresh.length)),
      };
    },
  };
}
