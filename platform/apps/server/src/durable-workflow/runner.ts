import { decideStep } from "./decide.js";
import { nextBackoffMs } from "./backoff.js";
import type { DurableRunStore, NewDurableRun } from "./store.js";
import type { BackoffPolicy, DurableRunRecord, StepHandler } from "./types.js";
import { isTerminal } from "./types.js";

/**
 * The durable-workflow engine (#338, ADR-0338). It DRIVES steps; it does not add a scheduler — the pure
 * {@link decideStep} chooses the action, this thin layer does the IO (call the handler, persist the next
 * state, set the backoff cursor, park for approval). Two entry points share one `advance` core:
 *
 *  - `advance(record)` — apply EXACTLY ONE step and persist. This is what an existing supervisor tick calls
 *    per due run (`store.listDue`), so a suspended run resumes across ticks AND across process restarts:
 *    the run's place is a persisted row, not an in-process promise.
 *  - `runToCompletion(opts)` — the foreground convenience: start (or resume), then advance in a loop,
 *    sleeping out each backoff window, until the run reaches a terminal status or parks for approval.
 *    Bounded by `maxAttempts` AND an absolute iteration cap, so it can NEVER hang — even if the injected
 *    clock misbehaves (the no-hang guarantee, the whole point of replacing the blocking `until` wait).
 *
 * Idempotency (#200 §2): `start` resolves to the EXISTING run for a repeated idempotency key (resume, not
 * fork); `advance` returns a terminal run untouched without calling the handler — a finished step is never
 * re-applied. The step handler is still required to be idempotent for its own in-flight attempt (#200 §3).
 */
export interface DurableRunnerDeps {
  store: DurableRunStore;
  /** Injected clock (epoch ms) so deadline/backoff are deterministic under test. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected sleep so tests don't burn wall-clock. Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export interface StartOptions<TState> {
  workspaceId: string;
  workflowKey: string;
  idempotencyKey: string;
  /** Wall-clock budget from now; the run fails `timeout` once it elapses (the no-hang bound). */
  timeoutMs: number;
  initialState: TState;
  requiresApproval?: boolean;
  approvalRequestId?: string | null;
}

export class DurableRunner {
  private readonly store: DurableRunStore;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: DurableRunnerDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))));
  }

  /** Idempotent start: resume the existing run for this key, or create a fresh `running` one. */
  async start<TState, TResult = unknown>(
    opts: StartOptions<TState>,
  ): Promise<DurableRunRecord<TState, TResult>> {
    const nowMs = this.now();
    const input: NewDurableRun<TState> = {
      workspaceId: opts.workspaceId,
      workflowKey: opts.workflowKey,
      idempotencyKey: opts.idempotencyKey,
      deadlineAtMs: nowMs + Math.max(0, opts.timeoutMs),
      requiresApproval: opts.requiresApproval ?? false,
      approvalRequestId: opts.approvalRequestId ?? null,
      state: opts.initialState,
      nowMs,
    };
    return this.store.findOrCreate<TState, TResult>(input);
  }

  /**
   * Apply ONE step to a run and persist the result. Pure decision + side effect + write. Returns the new
   * persisted record (so a tick can decide whether to schedule the next advance).
   */
  async advance<TState, TResult>(
    record: DurableRunRecord<TState, TResult>,
    handler: StepHandler<TState, TResult>,
    policy: BackoffPolicy,
  ): Promise<DurableRunRecord<TState, TResult>> {
    const nowMs = this.now();
    const decision = decideStep({
      status: record.status,
      attempts: record.attempts,
      maxAttempts: policy.maxAttempts,
      nowMs,
      deadlineAtMs: record.deadlineAtMs,
      nextAttemptAtMs: record.nextAttemptAtMs,
      requiresApproval: record.requiresApproval,
      approvalRequestId: record.approvalRequestId,
    });

    switch (decision.kind) {
      case "done":
        // Already terminal — read the persisted record back, never re-run (idempotency, #200 §2).
        return record;
      case "timeout":
        return this.persist(record, { status: "failed", error: "timeout", nextAttemptAtMs: null, nowMs });
      case "exhausted":
        return this.persist(record, {
          status: "failed",
          error: record.error ?? "max_attempts",
          nextAttemptAtMs: null,
          nowMs,
        });
      case "gate":
        // Irreversible without an approval — park for the owner (#13 always-gate, #200 §4). No side effect.
        return this.persist(record, {
          status: "waiting_approval",
          nextAttemptAtMs: null,
          nowMs,
        });
      case "wait":
        // Inside the backoff window — stay suspended; the cursor is already set. Nothing to apply.
        return record;
      case "run":
        return this.runStep(record, handler, policy, nowMs);
    }
  }

  private async runStep<TState, TResult>(
    record: DurableRunRecord<TState, TResult>,
    handler: StepHandler<TState, TResult>,
    policy: BackoffPolicy,
    nowMs: number,
  ): Promise<DurableRunRecord<TState, TResult>> {
    const attempts = record.attempts + 1;
    let outcome;
    try {
      outcome = await handler.step(record.state);
    } catch (err) {
      // A thrown handler is a retryable transient — suspend + back off (bounded by maxAttempts).
      outcome = { type: "failed" as const, retryable: true, error: errMsg(err) };
    }

    if (outcome.type === "done") {
      return this.persist(record, {
        status: "succeeded",
        attempts,
        result: outcome.result,
        nextAttemptAtMs: null,
        error: null,
        nowMs,
      });
    }
    if (outcome.type === "failed" && !outcome.retryable) {
      return this.persist(record, {
        status: "failed",
        attempts,
        error: outcome.error ?? "failed",
        nextAttemptAtMs: null,
        nowMs,
      });
    }
    // pending OR retryable failure → suspend with backoff so the next tick/loop resumes after the cursor.
    // Exponent is `attempts - 1`: the first retry waits one base unit, then doubles (base·2^0, base·2^1, …).
    const backoff = nextBackoffMs(attempts - 1, policy);
    return this.persist(record, {
      status: "suspended",
      attempts,
      nextAttemptAtMs: nowMs + backoff,
      error: outcome.type === "failed" ? (outcome.error ?? "retryable") : record.error,
      nowMs,
    });
  }

  /**
   * Foreground driver: start (or resume), then advance until terminal or parked for approval, sleeping out
   * each backoff window. Bounded TWO ways so it can never hang: the per-step `maxAttempts` cap, AND an
   * absolute iteration backstop (`2*maxAttempts + 8`) that force-fails the run `no_progress` if the loop
   * somehow churns without converging (e.g. a frozen injected clock). This is the durable replacement for
   * the blocking `while (Date.now() < deadline) { …; await sleep }` poll.
   */
  async runToCompletion<TState, TResult>(
    opts: StartOptions<TState>,
    handler: StepHandler<TState, TResult>,
    policy: BackoffPolicy,
  ): Promise<DurableRunRecord<TState, TResult>> {
    let record = await this.start<TState, TResult>(opts);
    const maxIterations = 2 * Math.max(1, policy.maxAttempts) + 8;
    for (let i = 0; i < maxIterations; i++) {
      if (isTerminal(record.status) || record.status === "waiting_approval") return record;
      const before = record;
      record = await this.advance(record, handler, policy);
      if (isTerminal(record.status) || record.status === "waiting_approval") return record;
      if (record.status === "suspended" && record.nextAttemptAtMs !== null) {
        await this.sleep(Math.max(0, record.nextAttemptAtMs - this.now()));
      } else if (sameProgress(before, record)) {
        // No state change and not terminal — break the loop rather than spin (defensive; cap also covers it).
        break;
      }
    }
    // Backstop: never return a non-terminal run from the foreground driver — fail closed (the no-hang law).
    if (!isTerminal(record.status) && record.status !== "waiting_approval") {
      record = await this.persist(record, {
        status: "failed",
        error: record.error ?? "no_progress",
        nextAttemptAtMs: null,
        nowMs: this.now(),
      });
    }
    return record;
  }

  private async persist<TState, TResult>(
    record: DurableRunRecord<TState, TResult>,
    patch: Partial<DurableRunRecord<TState, TResult>> & { nowMs: number },
  ): Promise<DurableRunRecord<TState, TResult>> {
    const { nowMs, ...fields } = patch;
    const next: DurableRunRecord<TState, TResult> = {
      ...record,
      ...fields,
      updatedAtMs: nowMs,
    };
    return this.store.save<TState, TResult>(next);
  }
}

function sameProgress(a: DurableRunRecord, b: DurableRunRecord): boolean {
  return a.status === b.status && a.attempts === b.attempts && a.nextAttemptAtMs === b.nextAttemptAtMs;
}

function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.slice(0, 200);
}
