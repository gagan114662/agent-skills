/**
 * Per-agent scoped credentials — pure allowlist matrix (issue #151, ADR-0151).
 *
 * #68/#25 resolve secrets per *tenant*: every agent in a workspace receives the same secret set. #151
 * narrows that to per *agent*: a matrix maps "purposes" (named groups of secret KEY names) to the agents
 * allowed to use them — scout reads the crawl token but never the Stripe key; postmark gets email creds
 * only. This module is pure: it decides the allowed key set and filters a resolved secret map. The secret
 * **values never live here** (nor in config) — only the non-secret key NAMES grouped by purpose (the #57
 * convention); the values stay on the #25 `SecretsResolver`/`AGENT_SECRETS` path.
 *
 * Default-OFF by contract: a disabled or empty matrix ⇒ the secrets pass through unchanged (today's
 * per-tenant behavior, byte-for-byte). When enabled, an agent absent from the matrix gets **only** the
 * always-keep keys (deny-by-default).
 */

/**
 * The non-secret allowlist policy (lives in the #58 config layer).
 * - `purposes`: a purpose name → the secret KEY names it covers (e.g. `crawl: ["CRAWL_TOKEN"]`).
 * - `agents`: an agent persona name (the @handle) → the purposes it may use (e.g. `scout: ["crawl"]`).
 */
export interface CredentialMatrix {
  enabled: boolean;
  purposes: Record<string, string[]>;
  agents: Record<string, string[]>;
}

/** A resolve-time scope: which agent (by member id) is launching, and an optional narrowing purpose. */
export interface CredentialScope {
  agentMemberId?: string | null;
  /** Resolved persona name for `agentMemberId` (the matrix key). Injected by the resolver's lookup. */
  agentName?: string | null;
  /** Optional: narrow to a single purpose's keys (∩ the agent's allowed purposes). */
  purpose?: string | null;
}

/** An empty, disabled matrix — the default that makes scoping a no-op. */
export const EMPTY_MATRIX: CredentialMatrix = { enabled: false, purposes: {}, agents: {} };

/** Resolve the #58 config partial into a full matrix, defaulting to OFF (today's per-tenant behavior). */
export function resolveCredentialMatrix(
  config: { enabled?: boolean; purposes?: Record<string, string[]>; agents?: Record<string, string[]> }
    | undefined,
): CredentialMatrix {
  return {
    enabled: config?.enabled ?? false,
    purposes: config?.purposes ?? {},
    agents: config?.agents ?? {},
  };
}

/**
 * The set of secret KEY names an agent may receive. Pure.
 * - Matrix disabled ⇒ `null` (sentinel: "no scoping — keep everything"). Callers MUST treat null as
 *   passthrough, distinct from an empty set (deny-all).
 * - Enabled + unknown/empty agent name ⇒ `[]` (deny-by-default; only always-keep keys survive).
 * - Enabled + known agent ⇒ the union of its purposes' keys, optionally narrowed to one `purpose`.
 */
export function allowedKeysForAgent(
  matrix: CredentialMatrix,
  agentName: string | null | undefined,
  purpose?: string | null,
): string[] | null {
  if (!matrix.enabled) return null;
  if (!agentName) return [];
  const purposesForAgent = matrix.agents[agentName] ?? [];
  const wanted = purpose ? purposesForAgent.filter((p) => p === purpose) : purposesForAgent;
  const keys = new Set<string>();
  for (const p of wanted) {
    for (const key of matrix.purposes[p] ?? []) keys.add(key);
  }
  return [...keys];
}

/**
 * Filter a resolved secret map down to `allowed` keys, always keeping `alwaysKeep` (the #68 model-auth
 * keys — a scoped agent must still be able to run the model). `allowed === null` ⇒ passthrough (the
 * matrix is off). Pure; never mutates its inputs.
 */
export function filterSecrets(
  secrets: Record<string, string>,
  allowed: string[] | null,
  alwaysKeep: readonly string[],
): Record<string, string> {
  if (allowed === null) return { ...secrets };
  const keep = new Set<string>([...allowed, ...alwaysKeep]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (keep.has(k)) out[k] = v;
  }
  return out;
}
