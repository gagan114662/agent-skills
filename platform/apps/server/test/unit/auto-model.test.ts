import { describe, expect, it } from "vitest";
import { AutoModelResolver, type AutoModelDeps } from "../../src/runtime/auto-model.js";
import type {
  GatewayRouteRequest,
  GatewayRoutingClient,
  GatewayRoutingDecision,
} from "../../src/runtime/gateway-client.js";
import { CONFIG_DEFAULTS, type ResolvedConfig } from "../../src/config/schema.js";
import type { UsageReader, UsageSnapshot } from "../../src/scale/usage.js";

/** A fully-resolved config with auto-model on (the owner-workspace shape). */
function config(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...CONFIG_DEFAULTS, autoModel: { enabled: true }, ...over };
}

/** A gateway decision the orchestrator accepted on `model` (escalating from `from` when given). */
function decision(over: Partial<GatewayRoutingDecision> = {}): GatewayRoutingDecision {
  return {
    chosen: "claude-sonnet-4-6",
    initialChoice: "claude-haiku-4-5",
    stage: "orchestrator",
    rationale: "Stage B (claude orchestrator) ratified claude-sonnet-4-6",
    validationVerdict: "accept",
    confidence: 0.82,
    escalations: [{ from: "claude-haiku-4-5", to: "claude-sonnet-4-6", reason: "low confidence (0.4)" }],
    estCostCents: 0.3,
    actualCostCents: 0.41,
    ok: true,
    ...over,
  };
}

/** A fake gateway client recording the request it received. */
function fakeClient(result: GatewayRoutingDecision | null): GatewayRoutingClient & {
  calls: GatewayRouteRequest[];
} {
  const calls: GatewayRouteRequest[] = [];
  return {
    calls,
    async route(req) {
      calls.push(req);
      return result;
    },
  };
}

function deps(over: Partial<AutoModelDeps> = {}): AutoModelDeps {
  return {
    client: fakeClient(decision()),
    loadConfig: () => config(),
    enabled: true,
    gatewayConfigured: true,
    ...over,
  };
}

describe("AutoModelResolver — enablement gates (default OFF)", () => {
  it("is disabled when the deployment master switch (RELOAD_AUTO_MODEL) is off", () => {
    const r = new AutoModelResolver(deps({ enabled: false }));
    expect(r.isEnabledFor(config())).toBe(false);
  });

  it("is disabled when no gateway URL is configured", () => {
    const r = new AutoModelResolver(deps({ gatewayConfigured: false }));
    expect(r.isEnabledFor(config())).toBe(false);
  });

  it("is disabled when the per-tenant autoModel.enabled config is off (default)", () => {
    const r = new AutoModelResolver(deps());
    expect(r.isEnabledFor({ ...CONFIG_DEFAULTS })).toBe(false); // autoModel: {} ⇒ undefined enabled
  });

  it("is enabled only when all three gates are on", () => {
    const r = new AutoModelResolver(deps());
    expect(r.isEnabledFor(config())).toBe(true);
  });

  it("resolve() returns undefined (no gateway call) when disabled — untouched behavior", async () => {
    const client = fakeClient(decision());
    const r = new AutoModelResolver(deps({ enabled: false, client }));
    expect(await r.resolve({ workspaceId: "ws1", task: "fix the bug" })).toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });
});

describe("AutoModelResolver — happy path + audit capture", () => {
  it("returns the chosen model as a validated selection + the full audit decision", async () => {
    const r = new AutoModelResolver(deps());
    const out = await r.resolve({ workspaceId: "ws1", task: "refactor the parser" });
    expect(out).toBeDefined();
    // The chosen model becomes the session's ANTHROPIC_MODEL via the #52 selection env.
    expect(out!.selection.model).toBe("claude-sonnet-4-6");
    expect(out!.selection.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    expect(out!.selection.provider).toBe("anthropic");
    // The audit "why?" record carries the line-of-control telemetry.
    expect(out!.decision.chosenModel).toBe("claude-sonnet-4-6");
    expect(out!.decision.stage).toBe("orchestrator");
    expect(out!.decision.validationVerdict).toBe("accept");
    expect(out!.decision.confidence).toBeCloseTo(0.82);
    expect(out!.decision.escalations).toHaveLength(1);
    expect(out!.decision.actualCostCents).toBeCloseTo(0.41);
    expect(out!.decision.tenant).toBe("ws1");
  });

  it("escalation to the terminal authority (opus) is captured", async () => {
    const client = fakeClient(
      decision({
        chosen: "claude-opus-4-8",
        escalations: [
          { from: "claude-sonnet-4-6", to: "claude-opus-4-8", reason: "low confidence (0.3)" },
        ],
        rationale: "reached terminal authority (claude-opus-4-8)",
      }),
    );
    const r = new AutoModelResolver(deps({ client }));
    const out = await r.resolve({ workspaceId: "ws1", task: "prove this theorem" });
    expect(out!.selection.model).toBe("claude-opus-4-8");
    expect(out!.decision.escalations[0].to).toBe("claude-opus-4-8");
  });
});

describe("AutoModelResolver — tenant scoping", () => {
  it("passes the workspace id as the gateway tenant (so its keys/ceilings apply)", async () => {
    const client = fakeClient(decision());
    const r = new AutoModelResolver(deps({ client }));
    await r.resolve({ workspaceId: "owner-ws", task: "summarize" });
    expect(client.calls[0].tenant).toBe("owner-ws");
    expect(client.calls[0].prompt).toBe("summarize");
  });
});

describe("AutoModelResolver — budget routing (cost ceiling)", () => {
  it("pins the ceiling from autoModel.maxCallCostCents when set", async () => {
    const client = fakeClient(decision());
    const r = new AutoModelResolver(
      deps({ client, loadConfig: () => config({ autoModel: { enabled: true, maxCallCostCents: 7 } }) }),
    );
    await r.resolve({ workspaceId: "ws1", task: "x" });
    expect(client.calls[0].costCeilingCents).toBe(7);
    expect(client.calls[0].costCeilingCents).toBeDefined();
  });

  it("routes the REMAINING #71 window budget when a usage reader is wired", async () => {
    const client = fakeClient(decision());
    const usage: UsageReader = {
      async read(): Promise<UsageSnapshot> {
        return { sessionsStarted: 3, computeSeconds: 120, estimatedCostCents: 200 };
      },
    };
    const r = new AutoModelResolver(
      deps({
        client,
        usage,
        loadConfig: () => config({ scale: { ...CONFIG_DEFAULTS.scale, budgetCents: 500 } }),
      }),
    );
    await r.resolve({ workspaceId: "ws1", task: "x" });
    expect(client.calls[0].costCeilingCents).toBe(300); // 500 budget − 200 accrued
  });

  it("passes the full configured budget when no usage reader is wired", async () => {
    const client = fakeClient(decision());
    const r = new AutoModelResolver(
      deps({ client, loadConfig: () => config({ scale: { ...CONFIG_DEFAULTS.scale, budgetCents: 500 } }) }),
    );
    await r.resolve({ workspaceId: "ws1", task: "x" });
    expect(client.calls[0].costCeilingCents).toBe(500);
  });

  it("routes the trial free-tier budget (500¢) through by default — the existing per-tenant cap", async () => {
    const client = fakeClient(decision());
    const r = new AutoModelResolver(deps({ client })); // CONFIG_DEFAULTS scale = TRIAL_SCALE_DEFAULTS (500¢)
    await r.resolve({ workspaceId: "ws1", task: "x" });
    expect(client.calls[0].costCeilingCents).toBe(500);
  });

  it("leaves the ceiling undefined when the tenant explicitly has no budget (gateway default applies)", async () => {
    const client = fakeClient(decision());
    const r = new AutoModelResolver(
      deps({ client, loadConfig: () => config({ scale: { ...CONFIG_DEFAULTS.scale, budgetCents: 0 } }) }),
    );
    await r.resolve({ workspaceId: "ws1", task: "x" });
    expect(client.calls[0].costCeilingCents).toBeUndefined();
  });
});

describe("AutoModelResolver — fallback never blocks a session", () => {
  it("returns undefined when the gateway is unavailable (route → null)", async () => {
    const r = new AutoModelResolver(deps({ client: fakeClient(null) }));
    expect(await r.resolve({ workspaceId: "ws1", task: "x" })).toBeUndefined();
  });

  it("returns undefined when the gateway could not produce an accepted answer (ok:false)", async () => {
    const r = new AutoModelResolver(deps({ client: fakeClient(decision({ ok: false, chosen: null })) }));
    expect(await r.resolve({ workspaceId: "ws1", task: "x" })).toBeUndefined();
  });

  it("returns undefined when the client throws", async () => {
    const throwing: GatewayRoutingClient = {
      async route() {
        throw new Error("boom");
      },
    };
    const r = new AutoModelResolver(deps({ client: throwing }));
    expect(await r.resolve({ workspaceId: "ws1", task: "x" })).toBeUndefined();
  });
});

describe("AutoModelResolver — policy is the final gate (defense in depth)", () => {
  it("rejects a chosen model the tenant's #52 allow-list forbids (falls back)", async () => {
    const client = fakeClient(decision({ chosen: "gpt-4o-mini" }));
    const r = new AutoModelResolver(
      deps({
        client,
        loadConfig: () =>
          config({ models: { allowedModels: ["claude-sonnet-4-6", "claude-opus-4-8"] } }),
      }),
    );
    // gpt-4o-mini ∉ allowedModels ⇒ resolveSelection throws SelectionError ⇒ undefined, never throws.
    expect(await r.resolve({ workspaceId: "ws1", task: "x" })).toBeUndefined();
  });

  it("accepts a chosen model that IS in the allow-list", async () => {
    const client = fakeClient(decision({ chosen: "claude-opus-4-8" }));
    const r = new AutoModelResolver(
      deps({
        client,
        loadConfig: () =>
          config({ models: { allowedModels: ["claude-sonnet-4-6", "claude-opus-4-8"] } }),
      }),
    );
    const out = await r.resolve({ workspaceId: "ws1", task: "x" });
    expect(out!.selection.model).toBe("claude-opus-4-8");
  });

  it("rejects a malformed model id without throwing", async () => {
    const client = fakeClient(decision({ chosen: "bad model;rm -rf" }));
    const r = new AutoModelResolver(deps({ client }));
    expect(await r.resolve({ workspaceId: "ws1", task: "x" })).toBeUndefined();
  });
});
