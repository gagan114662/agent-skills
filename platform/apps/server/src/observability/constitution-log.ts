import { initLogger } from "braintrust";
import { egressAllowed } from "../config/egress.js";
import type { ConstitutionViolation } from "../constitution/types.js";

/**
 * Braintrust-backed constitution-violation observer (#146). Every recorded violation becomes one
 * Braintrust event so constitutional drift is observable in the project dashboard alongside agent
 * sessions. Mirrors `observability/braintrust.ts`: a **no-op** when `BRAINTRUST_API_KEY` is unset or
 * the #58 egress gate disallows export (local dev, CI, unit tests, data-privacy mode never call out).
 * Best-effort — a telemetry failure never breaks a venture decision.
 */
export interface ConstitutionObserveInput {
  workspaceId: string;
  ideaId: string;
  stage: string;
  verdict: string;
  violation: ConstitutionViolation;
}

export interface ConstitutionObserver {
  log(input: ConstitutionObserveInput): void;
}

const NOOP: ConstitutionObserver = { log: () => {} };

/** A minimal view of the braintrust Logger (avoids depending on the SDK's exported types). */
interface BraintrustLogger {
  log(event: { input?: unknown; output?: unknown; metadata?: Record<string, unknown> }): unknown;
}

let memoized: BraintrustLogger | undefined;

export function createConstitutionObserver(opts: { dataPrivacyMode?: boolean } = {}): ConstitutionObserver {
  // The hard egress gate — no external export when #58 data-privacy disallows it.
  if (!egressAllowed({ dataPrivacyMode: opts.dataPrivacyMode ?? false })) return NOOP;
  if (!process.env.BRAINTRUST_API_KEY) return NOOP;
  const projectName = process.env.BRAINTRUST_PROJECT ?? "My Project";
  return {
    log: (input) => {
      try {
        memoized ??= initLogger({ projectName }) as unknown as BraintrustLogger;
        memoized.log({
          input: {
            stage: input.stage,
            verdict: input.verdict,
            ideaId: input.ideaId,
            workspaceId: input.workspaceId,
          },
          output: {
            article: input.violation.article,
            code: input.violation.code,
            severity: input.violation.severity,
            message: input.violation.message,
          },
          metadata: {
            kind: "constitution_violation",
            workspaceId: input.workspaceId,
            article: input.violation.article,
            code: input.violation.code,
            severity: input.violation.severity,
          },
        });
      } catch {
        // Best-effort observability — never break a decision on a telemetry failure.
      }
    },
  };
}
