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

export interface SecretsResolver {
  resolve(workspaceId: string): Promise<Record<string, string>>;
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

/** A resolver that always returns the same fixed secrets — used by tests and the demo. */
export class StaticSecretsResolver implements SecretsResolver {
  constructor(private readonly secrets: Record<string, string>) {}
  resolve(): Promise<Record<string, string>> {
    return Promise.resolve({ ...this.secrets });
  }
}

/**
 * Subscription-first secrets resolver (#68, ADR-0068). Injects the per-tenant Claude subscription
 * token (`CLAUDE_CODE_OAUTH_TOKEN`) so a session bills the OWNER's subscription — falling back to the
 * operator platform key (`ANTHROPIC_API_KEY`) only when the workspace has none. The auth layer OWNS
 * those two keys: any value an inner resolver supplies for them is stripped, so the chosen auth is
 * authoritative and a platform key never ships alongside a subscription token. Other secrets from the
 * inner resolver (e.g. `OPENAI_API_KEY` for the codex harness) pass through unchanged.
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
