import { loadConfig } from "../config/loader.js";
import { resolveConstitutionCaps } from "./caps.js";
import { countUnaffiliatedPayingIntent } from "../demand/signals.js";
import { recordViolation } from "../db/repositories/constitution.js";
import {
  createConstitutionObserver,
  type ConstitutionObserver,
} from "../observability/constitution-log.js";
import type { DemandEvidenceSource } from "../demand/service.js";
import type { FailureEvent } from "../flywheel/types.js";
import type { ConstitutionGuard, ConstitutionEvidence } from "../venture/service.js";
import type { SessionLogger } from "../runtime/manager.js";

/**
 * Production wiring for the YC Startup Constitution guard (#146, ADR-0146). Pure checks live in
 * `love-gate.ts`/`scorer.ts`/`caps.ts`; this assembles the IO seams the venture loop injects:
 *   - `caps`/`enabled` come from the layered config (default OFF).
 *   - `evidenceFor` reads the #101 demand rails — externally-attributed evidence ONLY — and reduces it
 *     to the three facts the Articles need.
 *   - `record` persists each violation (the durable Founder Console feed), hands it to the #117
 *     flywheel as a `constitution_violation` failure (so repeats fingerprint into an issue), and logs
 *     it to observability. Best-effort on the flywheel/observer legs — a failure there never breaks the
 *     venture decision; the durable row is the source of truth.
 */
export interface ConstitutionGuardDeps {
  /** The #101 demand source (externally-attributed willingness-to-pay evidence). */
  demand: DemandEvidenceSource;
  /** The #117 flywheel ingest, lazily referenced so it can be created after the venture service. */
  flywheelRecord?: (event: FailureEvent) => Promise<unknown>;
  observer?: ConstitutionObserver;
  logger?: SessionLogger;
}

export function createConstitutionGuard(deps: ConstitutionGuardDeps): ConstitutionGuard {
  const observer = deps.observer ?? createConstitutionObserver();
  return {
    enabled: (workspaceId) => resolveConstitutionCaps(loadConfig(workspaceId).constitution).enabled,
    caps: (workspaceId) => resolveConstitutionCaps(loadConfig(workspaceId).constitution),
    evidenceFor: async (workspaceId, ideaId): Promise<ConstitutionEvidence> => {
      // The demand source returns branded ExternalDemandEvidence — externally-attributed by
      // construction, so "unaffiliated" holds for every item; we just count + classify.
      const evidence = await deps.demand.externalDemandEvidence(workspaceId, ideaId);
      return {
        unaffiliatedPayingIntentSignals: countUnaffiliatedPayingIntent(evidence),
        externalDemandPresent: evidence.length > 0,
        paidSignalPresent: evidence.some((e) => e.signalClass === "paid"),
      };
    },
    record: async ({ workspaceId, ideaId, stage, verdict, violations }) => {
      for (const violation of violations) {
        // The durable row is the source of truth (Founder Console reads it).
        await recordViolation({ workspaceId, ideaId, verdict, violation });
        // Best-effort: feed the flywheel so a REPEATED violation fingerprints into one issue.
        if (deps.flywheelRecord) {
          try {
            await deps.flywheelRecord({
              workspaceId,
              failureClass: "constitution_violation",
              message: `${violation.article}:${violation.code} ${violation.message}`,
              source: "constitution",
              detail: `stage=${stage} verdict=${verdict} idea=${ideaId}`,
            });
          } catch (err) {
            deps.logger?.warn?.({ err, code: violation.code }, "constitution: flywheel ingest failed");
          }
        }
        // Best-effort observability.
        observer.log({ workspaceId, ideaId, stage, verdict, violation });
        deps.logger?.info?.(
          { workspaceId, ideaId, stage, verdict, article: violation.article, code: violation.code },
          "constitution violation flagged",
        );
      }
    },
  };
}
