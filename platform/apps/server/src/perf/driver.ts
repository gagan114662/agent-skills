import { summarize, type PerfResult } from "./budgets.js";

/**
 * Dependency-free closed-loop load driver (#113, ADR-0113). A fixed pool of `concurrency` workers each
 * pull from a shared request budget until `totalRequests` are issued, recording per-request latency and
 * counting failures. No autocannon/k6 binary — consistent with #19 (a Prometheus subset, not
 * `prom-client`) and #11 (a hand-rolled OpenAPI doc). The clock is injectable so the throughput/latency
 * math is deterministically unit-testable without a real timer or network.
 */

export interface LoadOptions {
  name: string;
  /** Total number of requests to issue across the whole run. */
  totalRequests: number;
  /** Number of concurrent in-flight requests (the closed-loop width). */
  concurrency: number;
}

export interface LoadRequestResult {
  ok: boolean;
}

/** One unit of work: issue a single request. A throw or `{ ok: false }` counts as an error. */
export type LoadRequest = () => Promise<LoadRequestResult>;

/** Monotonic millisecond clock. Defaults to `performance.now`; tests inject a deterministic one. */
export type Clock = () => number;

const defaultClock: Clock = () => performance.now();

/**
 * Drive `totalRequests` through `request` at `concurrency` width and summarize the run. The pool size
 * is clamped to the request budget, so `concurrency > totalRequests` simply issues fewer workers.
 */
export async function runLoad(
  opts: LoadOptions,
  request: LoadRequest,
  clock: Clock = defaultClock,
): Promise<PerfResult> {
  const total = Math.max(0, Math.floor(opts.totalRequests));
  const width = Math.max(1, Math.min(Math.floor(opts.concurrency), total || 1));

  const latencies: number[] = [];
  let issued = 0;
  let errors = 0;

  const start = clock();

  async function worker(): Promise<void> {
    // Pull from the shared budget until exhausted (closed loop: a worker starts the next request the
    // instant its previous one resolves).
    while (issued < total) {
      issued += 1;
      const t0 = clock();
      try {
        const res = await request();
        if (!res.ok) errors += 1;
      } catch {
        errors += 1;
      }
      latencies.push(clock() - t0);
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));

  const durationMs = Math.max(clock() - start, 1); // never divide by zero
  const stats = summarize(latencies);
  const requests = latencies.length;

  return {
    name: opts.name,
    requests,
    durationMs,
    rps: (requests * 1000) / durationMs,
    p50Ms: stats.p50Ms,
    p99Ms: stats.p99Ms,
    maxMs: stats.maxMs,
    errors,
    errorRate: requests > 0 ? errors / requests : 0,
  };
}
