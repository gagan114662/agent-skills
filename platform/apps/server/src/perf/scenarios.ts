import type { LoadRequest } from "./driver.js";
import type { PerfBudget } from "./budgets.js";

/**
 * Hot-path load scenarios + their perf budgets (#113, ADR-0113). Each scenario is a `LoadRequest` the
 * driver hammers; the budgets are **floor guards against catastrophic regression** (generous absolute
 * thresholds), not tight SLOs — so the CI gate catches a 10× slowdown without flapping on shared-runner
 * noise. A request "succeeds" for load purposes when the server *handled* it (status < 500): a 401/409
 * is a fast handled response, only a 5xx (or a thrown/refused connection) is an error.
 *
 * The scenarios are deliberately read/CPU paths that need no agent-process spawn or real spend:
 *  - `baseline`       GET /livez                 — bare framework throughput (the per-vCPU anchor)
 *  - `billing-webhook`POST /billing/webhook/:wid — the #98 inbound webhook routing + raw-body path
 *  - `agent-api-read` GET /me                    — the authenticated agent/session API surface (auth + DB)
 * Write/spend paths (session launch, venture advance) are the soak script's job (see ADR-0113 §6).
 */

export interface Scenario {
  name: string;
  request: LoadRequest;
}

// Floor guards against CATASTROPHIC regression, not tight SLOs (ADR-0113 §2). The gate leans on the
// stable signals — the req/s floor, median latency, and error rate — with a deliberately loose p99
// ceiling, because a single tail sample on a shared CI runner spikes (a healthy p50≈10ms run can show a
// p99≈460ms GC pause). The floors sit ~10–40× below observed throughput so normal noise never flaps,
// but a genuine 10× slowdown or a path that starts erroring still fails the PR.
export const HOT_PATH_BUDGETS: PerfBudget[] = [
  { name: "baseline", minRps: 200, maxP50Ms: 100, maxP99Ms: 2000, maxErrorRate: 0.02 },
  { name: "billing-webhook", minRps: 100, maxP50Ms: 150, maxP99Ms: 2000, maxErrorRate: 0.02 },
  { name: "agent-api-read", minRps: 60, maxP50Ms: 200, maxP99Ms: 2000, maxErrorRate: 0.02 },
];

export interface ScenarioContext {
  baseUrl: string;
  /** A signed-up session cookie value (`rid`) for the authenticated scenario. */
  cookie: string;
  /** A workspace id used to address the webhook route. */
  workspaceId: string;
}

/** A handled response (status < 500) counts as success; a 5xx or a thrown/refused request is an error. */
async function handled(fn: () => Promise<Response>): Promise<{ ok: boolean }> {
  const res = await fn();
  return { ok: res.status < 500 };
}

/** Build the hot-path scenarios against a live server. Uses the global `fetch` — no autocannon/k6. */
export function buildScenarios(ctx: ScenarioContext): Scenario[] {
  return [
    {
      name: "baseline",
      request: () => handled(() => fetch(`${ctx.baseUrl}/livez`)),
    },
    {
      name: "billing-webhook",
      request: () =>
        handled(() =>
          fetch(`${ctx.baseUrl}/billing/webhook/${ctx.workspaceId}`, {
            method: "POST",
            headers: { "content-type": "application/json", "stripe-signature": "t=0,v1=deadbeef" },
            body: JSON.stringify({ id: "evt_perf", type: "ping" }),
          }),
        ),
    },
    {
      name: "agent-api-read",
      request: () =>
        handled(() => fetch(`${ctx.baseUrl}/me`, { headers: { cookie: `rid=${ctx.cookie}` } })),
    },
  ];
}
