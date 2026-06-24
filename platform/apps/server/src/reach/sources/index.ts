import type { ProspectSource } from "../prospect-source.js";
import type { ProspectSourceKind } from "../types.js";
import { createMockProspectSource } from "./mock.js";
import { createClaySource } from "./clay.js";
import { createImportedProspectSource } from "./imported.js";
import { createLushaSource } from "./lusha.js";
import { createVibeSource } from "./vibe.js";
import type { HttpFetch } from "./http.js";

export { createMockProspectSource } from "./mock.js";
export { createClaySource } from "./clay.js";
export { createImportedProspectSource } from "./imported.js";
export { createLushaSource } from "./lusha.js";
export { createVibeSource } from "./vibe.js";
export { createHttpProspectSource } from "./http.js";
export type { HttpFetch, HttpResponse } from "./http.js";

/** The #192 vault service_key + env var the agents resolve once a paid data source is connected. */
export const PROSPECT_SOURCE_VAULT: Record<Exclude<ProspectSourceKind, "imported" | "mock">, { serviceKey: string; envKey: string }> = {
  clay: { serviceKey: "clay", envKey: "CLAY_API_KEY" },
  lusha: { serviceKey: "lusha", envKey: "LUSHA_API_KEY" },
  vibe: { serviceKey: "vibe", envKey: "VIBE_API_KEY" },
};

export interface ProspectSourceFactoryDeps {
  httpFetch: HttpFetch;
  /** Resolve a provider API key from the #192 vault (serviceKey, envKey) → secret, or null when absent. */
  loadApiKey: (serviceKey: string, envKey: string) => Promise<string | null>;
  loadImportedProspects?: (input: {
    workspaceId: string;
    limit: number;
    excludeKeys: ReadonlySet<string>;
  }) => Promise<import("../types.js").RawProspect[]>;
  now?: () => number;
}

/**
 * Build the configured {@link ProspectSource}. `imported` reads the owner's self-serve list; `mock` is
 * explicit demo data. Paid providers are constructed with a vault-backed `loadApiKey` and injected `httpFetch`.
 */
export function createProspectSource(
  kind: ProspectSourceKind,
  deps: ProspectSourceFactoryDeps,
  workspaceId = "",
): ProspectSource {
  switch (kind) {
    case "imported":
      return createImportedProspectSource(workspaceId, {
        loadImportedProspects: deps.loadImportedProspects ?? (async () => []),
      });
    case "mock":
      return createMockProspectSource({ now: deps.now });
    case "clay":
      return createClaySource({
        httpFetch: deps.httpFetch,
        loadApiKey: () => deps.loadApiKey(PROSPECT_SOURCE_VAULT.clay.serviceKey, PROSPECT_SOURCE_VAULT.clay.envKey),
        now: deps.now,
      });
    case "lusha":
      return createLushaSource({
        httpFetch: deps.httpFetch,
        loadApiKey: () => deps.loadApiKey(PROSPECT_SOURCE_VAULT.lusha.serviceKey, PROSPECT_SOURCE_VAULT.lusha.envKey),
        now: deps.now,
      });
    case "vibe":
      return createVibeSource({
        httpFetch: deps.httpFetch,
        loadApiKey: () => deps.loadApiKey(PROSPECT_SOURCE_VAULT.vibe.serviceKey, PROSPECT_SOURCE_VAULT.vibe.envKey),
        now: deps.now,
      });
  }
}
