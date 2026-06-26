/**
 * Per-tenant secret resolution (issue #25). Secrets are resolved *at provision time*, scoped to
 * the session's workspace, and injected into the runtime as env. They are never baked into a
 * snapshot and never logged (the SessionManager redacts their values from output).
 *
 * The interface is per-tenant by contract. The default env-backed implementation reads a JSON map
 * from `AGENT_SECRETS` keyed by workspace id (with a `*` fallback for shared secrets) plus a
 * convenience passthrough of named `process.env` keys listed in `AGENT_SECRET_KEYS`. A real
 * deployment swaps in a vault-backed resolver implementing the same interface.
 */
import { AGENT_AUTH_KEYS, type AgentAuthResolver } from "./agent-auth.js";
import {
  allowedKeysForAgent,
  filterSecrets,
  type CredentialMatrix,
  type CredentialScope,
} from "./credential-scope.js";

/**
 * Per-tenant secret resolution. The optional `scope` (#151) narrows the result to a single agent's
 * allowlisted keys — workspace-only callers omit it and keep today's per-tenant behavior. The base
 * resolvers ignore `scope`; only the `ScopedSecretsResolver` decorator acts on it.
 */
export interface SecretsResolver {
  resolve(workspaceId: string, scope?: CredentialScope): Promise<Record<string, string>>;
}

export class EnvSecretsResolver implements SecretsResolver {
  constructor(private readonly source: NodeJS.ProcessEnv = process.env) {}

  resolve(workspaceId: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};

    // 1. JSON map: { "*": {KEY: val}, "<workspaceId>": {KEY: val} } — workspace overrides shared.
    const raw = this.source.AGENT_SECRETS;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
        Object.assign(out, parsed["*"] ?? {}, parsed[workspaceId] ?? {});
      } catch {
        /* malformed AGENT_SECRETS is ignored rather than leaking a parse error with values */
      }
    }

    // 2. Named passthrough: AGENT_SECRET_KEYS=ANTHROPIC_API_KEY,OPENAI_API_KEY
    const keys = (this.source.AGENT_SECRET_KEYS ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    for (const key of keys) {
      const value = this.source[key];
      if (value !== undefined) out[key] = value;
    }

    return Promise.resolve(out);
  }
}

/**
 * Billing-only secrets (#98). Resolves the Stripe credentials directly from `process.env` so the live
 * key reaches the billing surface WITHOUT being added to the agent-facing `AGENT_SECRET_KEYS`
 * passthrough — which {@link EnvSecretsResolver} also serves as the inner resolver for every agent
 * session (see `runtime/default.ts`), so listing `STRIPE_SECRET_KEY` there would inject the live key
 * into every agent runtime. This resolver is consumed only by the billing surface, never the session
 * manager. Per-tenant `AGENT_SECRETS` overrides are still honored (so a custom-named or
 * workspace-scoped key keeps working); the named env passthrough is fixed to the Stripe key names.
 */
export class BillingSecretsResolver implements SecretsResolver {
  constructor(
    private readonly source: NodeJS.ProcessEnv = process.env,
    private readonly keys: readonly string[] = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  ) {}

  resolve(workspaceId: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};

    // Per-tenant overrides (same JSON shape as EnvSecretsResolver) take precedence when present.
    const raw = this.source.AGENT_SECRETS;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
        Object.assign(out, parsed["*"] ?? {}, parsed[workspaceId] ?? {});
      } catch {
        /* malformed AGENT_SECRETS is ignored rather than leaking a parse error with values */
      }
    }

    // Direct env passthrough — fixed to the Stripe key names, so this never widens agent exposure.
    for (const key of this.keys) {
      const value = this.source[key];
      if (value !== undefined && out[key] === undefined) out[key] = value;
    }

    return Promise.resolve(out);
  }
}

/** A resolver that always returns the same fixed secrets — used by tests and the demo. */
export class StaticSecretsResolver implements SecretsResolver {
  constructor(private readonly secrets: Record<string, string>) {}
  resolve(): Promise<Record<string, string>> {
    return Promise.resolve({ ...this.secrets });
  }
}

/**
 * Subscription-ONLY secrets resolver (#68, ADR-0068; tightened in #246). Injects the per-tenant Claude
 * subscription token (`CLAUDE_CODE_OAUTH_TOKEN`) so a session bills the OWNER's subscription, with NO
 * API-key fallback (#246) — an unconnected workspace gets no model credential at all (the @mention gate
 * posts a reconnect prompt instead of launching). The auth layer OWNS the model-auth keys
 * ({@link AGENT_AUTH_KEYS}, incl. `ANTHROPIC_API_KEY`): any value an inner resolver supplies for them is
 * STRIPPED, so an API key can never reach the agent runtime even if it leaks into `AGENT_SECRET_KEYS`.
 * Other non-model secrets from the inner resolver pass through; Codex subscription auth is deliberately
 * not treated as an API-key passthrough.
 */
export class SubscriptionSecretsResolver implements SecretsResolver {
  constructor(
    private readonly auth: AgentAuthResolver,
    private readonly inner?: SecretsResolver,
  ) {}

  async resolve(workspaceId: string): Promise<Record<string, string>> {
    const { secrets } = await this.auth.resolve(workspaceId);
    const extra = this.inner ? await this.inner.resolve(workspaceId) : {};
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(extra)) {
      if (!(AGENT_AUTH_KEYS as readonly string[]).includes(k)) rest[k] = v;
    }
    return { ...rest, ...secrets };
  }
}

/**
 * External-account secrets decorator (#192, ADR-0192). Wraps any inner resolver and, **iff** the
 * workspace has opted into onboarding (`onboarding.enabled`), merges in every connected external
 * service's secrets (ESP/ad/analytics/etc. keys the owner pasted once into the #192 write-only vault) so
 * the fleet operates the service without ever reading the key back — the values flow only as injected,
 * redacted env. Connected-service values win for their own keys (the owner connected them deliberately);
 * everything else passes through from the inner resolver unchanged.
 *
 * **Default-OFF by contract:** when `isEnabled(workspaceId)` is false (the default) the inner result is
 * returned byte-for-byte — no DB read, no behavior change. The enabled check + the per-workspace secret
 * load are injected seams so the decorator stays unit-testable; production wires them to `loadConfig` +
 * the `external_credentials` repo.
 */
export class ExternalSecretsResolver implements SecretsResolver {
  constructor(
    private readonly inner: SecretsResolver,
    private readonly deps: {
      isEnabled: (workspaceId: string) => boolean;
      loadServiceSecrets: (workspaceId: string) => Promise<Record<string, string>>;
    },
  ) {}

  async resolve(workspaceId: string, scope?: CredentialScope): Promise<Record<string, string>> {
    const base = await this.inner.resolve(workspaceId, scope);
    if (!this.deps.isEnabled(workspaceId)) return base;
    const external = await this.deps.loadServiceSecrets(workspaceId);
    return { ...base, ...external };
  }
}

/**
 * Per-agent scoping decorator (#151, ADR-0151). Wraps any inner resolver and, **iff** the workspace's
 * credential matrix is enabled and the launching agent resolves to a persona name, filters the resolved
 * secrets down to that agent's allowlisted keys (scout↛Stripe, postmark→email-only). The #68 model-auth
 * keys are always kept so a scoped agent still runs the model.
 *
 * Default-OFF by contract: a disabled/empty matrix, a workspace-only call (no `scope.agentMemberId`), or
 * an unknown agent with the matrix off ⇒ the inner result passes through **unchanged** (byte-for-byte).
 * The matrix loader + the agentId→name lookup are injected seams so the decorator stays DB-free and
 * unit-testable; production wires them to `loadConfig` + the personas repo.
 */
export class ScopedSecretsResolver implements SecretsResolver {
  constructor(
    private readonly inner: SecretsResolver,
    private readonly deps: {
      loadMatrix: (workspaceId: string) => CredentialMatrix;
      lookupAgentName: (workspaceId: string, agentMemberId: string) => Promise<string | null>;
    },
  ) {}

  async resolve(workspaceId: string, scope?: CredentialScope): Promise<Record<string, string>> {
    const secrets = await this.inner.resolve(workspaceId, scope);
    const matrix = this.deps.loadMatrix(workspaceId);
    // Disabled matrix ⇒ no scoping at all (passthrough), regardless of who is launching.
    if (!matrix.enabled) return secrets;
    // No agent context at all ⇒ this is a workspace-only call (billing/deploy/integrations); never
    // scoped. An agent launch ALWAYS carries an agentMemberId (or an explicit agentName).
    if (!scope?.agentMemberId && !scope?.agentName) return secrets;
    // Resolve the persona name to key the matrix on: prefer an explicit scope.agentName, else look the
    // agent member id up. An unresolved name (an agent with no persona row) stays null ⇒
    // `allowedKeysForAgent` returns [] (deny-by-default for an unidentifiable launching agent).
    let agentName = scope.agentName ?? null;
    if (!agentName && scope.agentMemberId) {
      agentName = await this.deps.lookupAgentName(workspaceId, scope.agentMemberId);
    }
    const allowed = allowedKeysForAgent(matrix, agentName, scope.purpose ?? null);
    return filterSecrets(secrets, allowed, AGENT_AUTH_KEYS);
  }
}
