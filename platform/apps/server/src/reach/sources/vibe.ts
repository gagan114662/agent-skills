import { createHttpProspectSource, type HttpProspectSourceDeps } from "./http.js";
import { coerceProspect, resultRows } from "./coerce.js";
import type { ProspectSource } from "../prospect-source.js";
import type { RawProspect } from "../types.js";

/** Vibe Prospecting source (#280) — permitted API only, paid (search credits ⇒ money-gated search). */
export const VIBE_COST_PER_PROSPECT_CENTS = 4;

export function createVibeSource(deps: HttpProspectSourceDeps & { now?: () => number }): ProspectSource {
  const now = deps.now ?? (() => Date.now());
  return createHttpProspectSource(
    {
      kind: "vibe",
      costPerProspectCents: VIBE_COST_PER_PROSPECT_CENTS,
      buildRequest: (input, apiKey) => ({
        url: "https://api.vibe.co/v1/prospects/search",
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          roles: input.icp.roles,
          industries: input.icp.industries,
          signals: input.icp.signalKinds,
          limit: input.limit,
        }),
      }),
      mapResponse: (json): RawProspect[] => {
        const nowMs = now();
        return resultRows(json, ["prospects", "data", "results"])
          .map((r) => coerceProspect(r, "vibe", nowMs))
          .filter((p): p is RawProspect => p !== null);
      },
    },
    deps,
  );
}
