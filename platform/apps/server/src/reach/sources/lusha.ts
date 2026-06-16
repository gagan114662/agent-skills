import { createHttpProspectSource, type HttpProspectSourceDeps } from "./http.js";
import { coerceProspect, resultRows } from "./coerce.js";
import type { ProspectSource } from "../prospect-source.js";
import type { RawProspect } from "../types.js";

/** Lusha prospect source (#280) — permitted API only, paid (contact credits ⇒ money-gated search). */
export const LUSHA_COST_PER_PROSPECT_CENTS = 8;

export function createLushaSource(deps: HttpProspectSourceDeps & { now?: () => number }): ProspectSource {
  const now = deps.now ?? (() => Date.now());
  return createHttpProspectSource(
    {
      kind: "lusha",
      costPerProspectCents: LUSHA_COST_PER_PROSPECT_CENTS,
      buildRequest: (input, apiKey) => ({
        url: "https://api.lusha.com/prospecting/contact/search",
        method: "POST",
        headers: { api_key: apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          filters: {
            jobTitles: input.icp.roles,
            industries: input.icp.industries,
            companySizes: input.icp.companySizes,
          },
          limit: input.limit,
        }),
      }),
      mapResponse: (json): RawProspect[] => {
        const nowMs = now();
        return resultRows(json, ["contacts", "data", "results"])
          .map((r) => coerceProspect(r, "lusha", nowMs))
          .filter((p): p is RawProspect => p !== null);
      },
    },
    deps,
  );
}
