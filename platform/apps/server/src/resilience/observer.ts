/**
 * Retry observability seam (issue #637: "the retry visible in the trace"). The retry orchestrator
 * (`execute.ts`) emits a {@link RetryEvent} at every interesting moment — an attempt starting, a retry
 * being scheduled, a final give-up, an eventual success. Whoever wires the module up maps these onto the
 * trace (#560) / run-log (#665) / logger.
 *
 * We keep this a *seam* (a structured-event callback) rather than importing the trace writer directly, so
 * the #637 change set stays self-contained and collision-free with sibling branches, and so the
 * orchestrator is unit-testable with a recording fake. The default is {@link NOOP_RETRY_OBSERVER} (emits
 * nothing); {@link createLoggingObserver} adapts a Fastify-style logger in a one-liner.
 */

import type { FailureClass } from "./types.js";
import type { GiveUpReason } from "./decide.js";

/** Every retry lifecycle event carries the operation label so the trace shows *which* call retried. */
export type RetryEvent =
  | { readonly type: "attempt"; readonly operation: string; readonly attempt: number }
  | {
      readonly type: "retry";
      readonly operation: string;
      /** The attempt that just failed (1-based). */
      readonly attempt: number;
      /** The attempt about to run after the wait. */
      readonly nextAttempt: number;
      /** How long the orchestrator will wait before the next attempt, in ms. */
      readonly delayMs: number;
      readonly failure: FailureClass;
    }
  | {
      readonly type: "give_up";
      readonly operation: string;
      readonly attempt: number;
      readonly reason: GiveUpReason;
      readonly failure: FailureClass;
    }
  | {
      readonly type: "success";
      readonly operation: string;
      /** The attempt that finally succeeded (1 ⇒ first try, >1 ⇒ a retry saved the run). */
      readonly attempt: number;
    };

export interface RetryObserver {
  /** Record one retry lifecycle event. Must not throw — the orchestrator never guards it. */
  onEvent(event: RetryEvent): void;
}

/** The default observer: records nothing. */
export const NOOP_RETRY_OBSERVER: RetryObserver = {
  onEvent() {
    /* intentionally empty */
  },
};

/** The subset of a Fastify-style logger this module needs (so the real `app.log` drops in). */
export interface ResilienceLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Adapt a structured logger into a {@link RetryObserver}: retries/give-ups log at `warn`, attempts and
 * successes at `info`. The structured payload (operation, attempt, delay, failure kind/status) is exactly
 * what a trace query filters on, so this doubles as the "visible in the trace" wiring for log-backed
 * traces.
 */
export function createLoggingObserver(log: ResilienceLogger): RetryObserver {
  return {
    onEvent(event: RetryEvent): void {
      switch (event.type) {
        case "attempt":
          log.info({ operation: event.operation, attempt: event.attempt }, `[resilience] attempt ${event.attempt} of ${event.operation}`);
          return;
        case "retry":
          log.warn(
            {
              operation: event.operation,
              attempt: event.attempt,
              nextAttempt: event.nextAttempt,
              delayMs: event.delayMs,
              failureKind: event.failure.kind,
              status: event.failure.status,
              retryAfterMs: event.failure.retryAfterMs,
            },
            `[resilience] ${event.operation} failed (${event.failure.kind}); retrying in ${event.delayMs}ms (attempt ${event.nextAttempt})`,
          );
          return;
        case "give_up":
          log.warn(
            {
              operation: event.operation,
              attempt: event.attempt,
              reason: event.reason,
              failureKind: event.failure.kind,
              status: event.failure.status,
            },
            `[resilience] ${event.operation} gave up after attempt ${event.attempt} (${event.reason})`,
          );
          return;
        case "success":
          log.info(
            { operation: event.operation, attempt: event.attempt },
            `[resilience] ${event.operation} succeeded on attempt ${event.attempt}`,
          );
          return;
      }
    },
  };
}
