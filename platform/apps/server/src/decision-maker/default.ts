import { DecisionMakerService } from "./service.js";
import { resolveDecisionMakerCaps } from "./caps.js";
import { StaticProfileReader } from "./quarantine.js";
import { loadConfig } from "../config/loader.js";
import {
  insertBuyerBrief,
  listBuyerBriefs,
  getBuyerBrief,
} from "../db/repositories/decision-maker.js";

/**
 * Production wiring for the decision-maker resolver (#223, ADR-0223). The brief ledger is backed by the
 * workspace-scoped `buyer_briefs` repo; enrichment uses the no-network {@link StaticProfileReader} (it
 * grounds hooks in the public text the discovery layer already fetched). The `accounts` (#222) seam is
 * intentionally left UNSET — the route accepts a target account directly until the discovery queue lands.
 *
 * Note the dependency surface: a reader, a brief store, a config resolver. No #13 gate, no send seam — the
 * service is structurally incapable of sending or spending (the #200 injection defense).
 */
export function createDefaultDecisionMakerService(): DecisionMakerService {
  return new DecisionMakerService({
    reader: new StaticProfileReader(),
    briefs: { insert: insertBuyerBrief, list: listBuyerBriefs, get: getBuyerBrief },
    caps: (workspaceId) => resolveDecisionMakerCaps(loadConfig(workspaceId).decisionMaker),
  });
}
