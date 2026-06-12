/**
 * Client for the convene-llm-gateway model auto-selection service
 * (github.com/gagan114662/convene-llm-gateway). We integrate over HTTP (the gateway is a stateful
 * service: a live provider model registry, circuit breaker, per-call telemetry, and provider keys in
 * ITS env) rather than vendoring it — so the gateway stays the single secret/policy/telemetry boundary
 * and no provider key ever enters this server's env.
 *
 * The only endpoint we call is `POST /auto/complete` (flag-gated by `AUTO_ROUTING_ENABLED` on the
 * gateway): it runs the two-stage router (deterministic heuristics → cheap Claude for ambiguous),
 * Claude **orchestrates + validates** the worker's output, **escalates** up the ladder
 * (sonnet → opus-4-8, the terminal authority) on low confidence/failure, and returns the full routing
 * **decision** — which model, why, the validation verdict, every escalation, and cost. We use the
 * decision's `chosen` model as the session's model and persist the decision as the "why?" audit record.
 *
 * Security: the gateway shared-secret is read from `process.env[tokenEnvVar]` (default `LLM_GATEWAY_KEY`)
 * at call time and sent ONLY as an `Authorization: Bearer` header — never logged, returned, or stored.
 * On ANY failure (disabled/unreachable/timeout/bad-status/parse) `route()` returns `null` so the caller
 * degrades to the deployment-default model and a session is never blocked.
 */

/** A routing request (secret-free). `tenant` is the workspace id so the gateway applies its keys/ceilings. */
export interface GatewayRouteRequest {
  /** The session's task — used by the router's heuristics/orchestrator to profile the work. */
  prompt: string;
  /** Per-tenant scope: the gateway resolves this tenant's enabled providers + cost ceiling. */
  tenant: string;
  /** Per-call cost ceiling (cents) routed through to the gateway's policy. Omitted ⇒ gateway default. */
  costCeilingCents?: number;
  /** Optional explicit task-type hint (an "obvious" case that bypasses the Claude routing call). */
  taskTypeHint?: string;
}

/** One escalation hop the orchestrator took (worker → sonnet → opus). Secret-free, prompt-free. */
export interface GatewayEscalationHop {
  from: string;
  to: string;
  reason: string;
  confidenceBefore?: number;
}

/**
 * The gateway's routing decision (a secret-free, prompt-free projection of its `RoutingRecord`). This
 * is exactly the "why this model" telemetry we persist to the session audit trail.
 */
export interface GatewayRoutingDecision {
  /** The final model that produced an accepted answer — the model we run the session on. Null = failed. */
  chosen: string | null;
  /** The model first selected before any escalation. */
  initialChoice: string | null;
  /** Which stage decided the route: `heuristic` bypass vs the Claude `orchestrator`. */
  stage: string;
  /** Human-readable rationale (candidates considered, why this model, terminal-authority note). */
  rationale: string;
  /** The validation verdict on the chosen model's output: `accept` | `escalate` | `reject` | `failed`. */
  validationVerdict: string;
  /** Final quality confidence (0..1). */
  confidence: number;
  /** Every escalation hop the orchestrator took. */
  escalations: GatewayEscalationHop[];
  /** Estimated vs actual cost (cents) of the routing run. */
  estCostCents: number;
  actualCostCents: number;
  /** Whether the run produced a usable, non-rejected answer. */
  ok: boolean;
}

/** The narrow seam the {@link AutoModelResolver} consumes — a fake in tests, HTTP in production. */
export interface GatewayRoutingClient {
  /** Ask the gateway which model to use. Returns null on any failure (caller falls back, never blocks). */
  route(req: GatewayRouteRequest): Promise<GatewayRoutingDecision | null>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpGatewayRoutingClientOpts {
  /** Gateway base URL (`LLM_GATEWAY_URL`), e.g. `https://gateway.internal`. */
  baseUrl: string;
  /** Env var holding the gateway shared-secret. Default `LLM_GATEWAY_KEY`. Value read at call time. */
  tokenEnvVar?: string;
  /** Request timeout in ms. Default 4000. A slow gateway falls back rather than blocking a launch. */
  timeoutMs?: number;
  /** Injectable fetch + env for tests; default to the runtime globals. */
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

/** A decision parsed from the gateway's `{ ok, text, decision }` body — secret-free, prompt-free. */
function parseDecision(body: unknown): GatewayRoutingDecision | null {
  if (typeof body !== "object" || body === null) return null;
  // `ok` is a TOP-LEVEL field of the response body (the HandleResult), NOT a field of `decision`.
  // Reading it off `decision` left it always-undefined ⇒ auto-selection always fell back. Read it here.
  const ok = (body as { ok?: unknown }).ok === true;
  const decision = (body as { decision?: unknown }).decision;
  if (typeof decision !== "object" || decision === null) return null;
  const d = decision as Record<string, unknown>;
  const chosen = typeof d.chosen === "string" ? d.chosen : null;
  const escalations = Array.isArray(d.escalations)
    ? d.escalations
        .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
        .map((e) => ({
          from: String(e.from ?? ""),
          to: String(e.to ?? ""),
          reason: String(e.reason ?? ""),
          confidenceBefore:
            typeof e.confidenceBefore === "number" ? e.confidenceBefore : undefined,
        }))
    : [];
  return {
    chosen,
    initialChoice: typeof d.initialChoice === "string" ? d.initialChoice : null,
    stage: typeof d.stage === "string" ? d.stage : "unknown",
    rationale: typeof d.rationale === "string" ? d.rationale : "",
    validationVerdict: typeof d.validationVerdict === "string" ? d.validationVerdict : "n/a",
    confidence: typeof d.confidence === "number" ? d.confidence : 0,
    escalations,
    estCostCents: typeof d.estCostCents === "number" ? d.estCostCents : 0,
    actualCostCents: typeof d.actualCostCents === "number" ? d.actualCostCents : 0,
    ok,
  };
}

export class HttpGatewayRoutingClient implements GatewayRoutingClient {
  private readonly baseUrl: string;
  private readonly tokenEnvVar: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: HttpGatewayRoutingClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.tokenEnvVar = opts.tokenEnvVar ?? "LLM_GATEWAY_KEY";
    this.timeoutMs = opts.timeoutMs ?? 4_000;
    // `fetch` is global in Node 18+; injectable for tests.
    this.fetchImpl =
      opts.fetchImpl ?? ((url, init) => (globalThis.fetch as FetchLike)(url, init));
    this.env = opts.env ?? process.env;
  }

  async route(req: GatewayRouteRequest): Promise<GatewayRoutingDecision | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      // Read the shared-secret at call time and attach it as a bearer header ONLY. Never logged.
      const token = this.env[this.tokenEnvVar];
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await this.fetchImpl(`${this.baseUrl}/auto/complete`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          prompt: req.prompt,
          tenant: req.tenant,
          costCeilingCents: req.costCeilingCents,
          taskTypeHint: req.taskTypeHint,
        }),
      });
      // 404 ⇒ AUTO_ROUTING_ENABLED is off on the gateway; any non-2xx ⇒ fall back.
      if (!res.ok) return null;
      const body: unknown = await res.json();
      return parseDecision(body);
    } catch {
      // Timeout / network / parse error — degrade to the deployment default, never block a session.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
