import { createHttpProspectSource, type HttpProspectSourceDeps } from "./http.js";
import { coerceProspect, resultRows } from "./coerce.js";
import type { ProspectSource } from "../prospect-source.js";
import type { RawProspect } from "../types.js";

/** Clay prospect source (#280) — permitted API only, paid (data credits ⇒ money-gated search). */
export const CLAY_COST_PER_PROSPECT_CENTS = 5;

export function createClaySource(deps: HttpProspectSourceDeps & { now?: () => number }): ProspectSource {
  const now = deps.now ?? (() => Date.now());
  return createHttpProspectSource(
    {
      kind: "clay",
      costPerProspectCents: CLAY_COST_PER_PROSPECT_CENTS,
      buildRequest: (input, apiKey) => ({
        url: "https://api.clay.com/v1/people/search",
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          titles: input.icp.roles,
          industries: input.icp.industries,
          companySizes: input.icp.companySizes,
          keywords: input.icp.keywords,
          limit: input.limit,
        }),
      }),
      mapResponse: (json): RawProspect[] => {
        const nowMs = now();
        return resultRows(json, ["data", "people", "results"])
          .map((r) => coerceProspect(r, "clay", nowMs))
          .filter((p): p is RawProspect => p !== null);
      },
    },
    deps,
  );
}
