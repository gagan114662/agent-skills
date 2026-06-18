import type { DurableAction, DurableRunStatus } from "./types.js";
import { isTerminal } from "./types.js";

/**
 * The durable-step decision (#338, ADR-0338) — **pure + unit-tested**, the exact `decideRevival` (#105) /
 * `decideWorkflowAction` (#17) split: given the persisted run state + the clock, return the SINGLE action
 * the runner applies this tick. The runner does the IO (call the step, persist, set the next-attempt
 * cursor, park for approval); this function does the choice.
 *
 * Priority is deliberate — terminal and hard stops first, then the bounded policy:
 *   1. terminal status (succeeded/failed/canceled) → done     (idempotency §2 — never re-run a finished run)
 *   2. now ≥ deadline                              → timeout  (the no-hang guarantee; bounded wall clock)
 *   3. attempts ≥ maxAttempts                       → exhausted (bounded retries — never retry forever)
 *   4. irreversible step without an approvalRequestId → gate   (the structural #13 always-gate, §4)
 *   5. inside the backoff window (now < nextAttemptAt) → wait  (suspended; don't hammer)
 *   6. otherwise                                    → run
 *
 * Note the order: the deadline beats exhaustion which beats the gate — a run that has already blown its
 * wall-clock budget fails closed regardless of how many attempts remain or whether a human ever approves.
 */
export interface StepDecisionInput {
  status: DurableRunStatus;
  /** Attempts of the current step already RUN. */
  attempts: number;
  /** Hard cap on attempts (bounded retries). */
  maxAttempts: number;
  /** Epoch-ms now (injected — the core never reads the clock itself). */
  nowMs: number;
  /** Epoch-ms hard deadline (the no-hang bound). */
  deadlineAtMs: number;
  /** Epoch-ms the next attempt is eligible, or null when runnable immediately. */
  nextAttemptAtMs: number | null;
  /** The step is irreversible (#200 §4) — must not RUN without an approval. */
  requiresApproval: boolean;
  /** The #13 approval id authorizing the irreversible step, or null. */
  approvalRequestId: string | null;
}

const action = (kind: DurableAction["kind"], reason: string, untilMs = 0): DurableAction => {
  if (kind === "wait") return { kind, untilMs, reason };
  return { kind, reason } as DurableAction;
};

export function decideStep(input: StepDecisionInput): DurableAction {
  const {
    status,
    attempts,
    maxAttempts,
    nowMs,
    deadlineAtMs,
    nextAttemptAtMs,
    requiresApproval,
    approvalRequestId,
  } = input;

  // 1. Already finished — read the persisted result back, never re-run (idempotency, #200 §2).
  if (isTerminal(status)) return action("done", "terminal");

  // 2. Out of wall-clock budget — fail closed so a stuck job can never hang the loop (#338 core promise).
  if (nowMs >= deadlineAtMs) return action("timeout", "deadline_exceeded");

  // 3. Out of attempts — bounded retries, never an infinite retry storm.
  if (attempts >= maxAttempts) return action("exhausted", "max_attempts");

  // 4. Irreversible without an approval — the structural #13 always-gate (#200 §4). Park, don't run.
  if (requiresApproval && !approvalRequestId) return action("gate", "needs_approval");

  // 5. Still inside the backoff window — suspended; resume when the cursor elapses.
  if (nextAttemptAtMs !== null && nowMs < nextAttemptAtMs) {
    return action("wait", "backoff", nextAttemptAtMs);
  }

  // 6. Runnable now.
  return action("run", "runnable");
}
