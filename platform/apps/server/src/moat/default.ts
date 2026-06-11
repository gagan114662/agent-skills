import { loadConfig } from "../config/loader.js";
import { resolveMoatCaps } from "./caps.js";
import { MoatService, type MoatRepo } from "./service.js";
import { recordAccrual, listAccruals } from "../db/repositories/moat.js";

/**
 * Production wiring for Moat Accrual (#103, ADR-0103). The repo is the real `moat_ledger`; caps come
 * from the per-workspace layered config (default OFF). Pure scoring/stagnation lives in `score.ts`.
 */

export const moatRepo = { recordAccrual, listAccruals } satisfies MoatRepo;

/** Build the production MoatService over the real ledger + per-workspace caps. */
export function createDefaultMoatService(now?: () => Date): MoatService {
  return new MoatService({
    repo: moatRepo,
    caps: (workspaceId) => resolveMoatCaps(loadConfig(workspaceId).moat),
    now,
  });
}
