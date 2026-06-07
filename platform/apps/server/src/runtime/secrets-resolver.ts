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
