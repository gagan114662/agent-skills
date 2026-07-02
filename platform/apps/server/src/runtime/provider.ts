import type { HarnessKind } from "./harness.js";

/**
 * Legacy Codex-only readiness (#1282) — the shape the Codex doctor probe produces. Canonical home is
 * HERE (the provider layer) so the routes and the doctor probe both depend downward; `routes/team.ts`
 * re-exports these names for existing importers.
 */
export interface CodexSubscriptionStatus {
  connected: boolean;
  reason: string;
  selectedHarness: "codex";
  userAuthenticated: boolean;
  workspaceAuthenticated: boolean;
  runtimeAuth: "signed_in_subscription" | "missing";
  fallback: "none";
  apiKeySatisfies: false;
}

export interface CodexSubscriptionStatusProvider {
  status(workspaceId: string, memberId: string): Promise<CodexSubscriptionStatus>;
}

/**
 * Agent runtime PROVIDER selection (#1568).
 *
 * The provider is the model vendor whose agent CLI actually executes fleet sessions — the thing the
 * owner switches when they say "run the team on Claude, not Codex". It sits ABOVE the #50 harness
 * abstraction: a provider maps 1:1 onto the real harness that runs it (`claude` → `claude-code`,
 * `codex` → `codex`), and everything downstream (posture presets, team-run preflight, the /everyday
 * dispatch default, the readiness dashboard) keys off the ONE resolved provider instead of hardcoding
 * a harness kind. Selection is env-driven (`AGENT_RUNTIME_PROVIDER`), never client-supplied.
 *
 * Owner decision (2026-07-02): the fleet default is **`claude`** (Anthropic). `codex` remains fully
 * supported behind the same env switch, so this is a default flip + a pluggable seam — not a removal.
 */
export type RuntimeProvider = "claude" | "codex";

/** The full allowlist of runtime providers — env parsing validates against this. */
export const RUNTIME_PROVIDERS = ["claude", "codex"] as const;

/** The project-canonical provider: Claude via the Anthropic API / Claude Code CLI. */
export const DEFAULT_RUNTIME_PROVIDER: RuntimeProvider = "claude";

/** Narrow an untrusted string to a {@link RuntimeProvider}. */
export function isRuntimeProvider(value: unknown): value is RuntimeProvider {
  return typeof value === "string" && (RUNTIME_PROVIDERS as readonly string[]).includes(value);
}

/** Parse `AGENT_RUNTIME_PROVIDER`; an unset/unknown value falls back to the Claude default. */
export function parseRuntimeProvider(value: string | undefined): RuntimeProvider {
  return isRuntimeProvider(value) ? value : DEFAULT_RUNTIME_PROVIDER;
}

/** The REAL harness a provider executes on (the demo harness is posture-selected, never provider-selected). */
export function harnessForProvider(provider: RuntimeProvider): Extract<HarnessKind, "claude-code" | "codex"> {
  return provider === "codex" ? "codex" : "claude-code";
}

/**
 * Provider-agnostic runtime readiness — the shape `GET /me/runtime/status` returns and the team-run
 * preflight gates on. Deliberately a SUPERSET-compatible evolution of the legacy
 * {@link CodexSubscriptionStatus} (same field names + meanings, widened unions), so the deployed
 * dashboard's existing `/me/codex/status` consumers keep working through the provider switch.
 */
export interface RuntimeStatus {
  provider: RuntimeProvider;
  connected: boolean;
  reason: string;
  selectedHarness: "claude-code" | "codex";
  userAuthenticated: boolean;
  workspaceAuthenticated: boolean;
  runtimeAuth: "signed_in_subscription" | "api_key" | "missing";
  /**
   * How the runtime authenticates (#1568, owner decision): `subscription` = a Claude subscription
   * token (the workspace's own connect OR the deployment `CLAUDE_CODE_OAUTH_TOKEN` from
   * `claude setup-token`) — the primary path; `api_key` = the optional `ANTHROPIC_API_KEY`
   * fallback; null = not connected.
   */
  authMode: "subscription" | "api_key" | null;
  fallback: "none";
  apiKeySatisfies: boolean;
}

export interface RuntimeStatusProvider {
  status(workspaceId: string, memberId: string): Promise<RuntimeStatus>;
}

export interface ClaudeAuthModeResult {
  mode: "subscription" | "api_key" | "none";
  /** Plain-language cause for `none` when known (e.g. a present-but-malformed workspace token). */
  reason?: string;
}

export interface ClaudeRuntimeStatusDeps {
  /**
   * The auth mode the runtime would launch this workspace with — the SAME decision the
   * SessionManager's secrets path makes (`AgentAuthResolver.resolve(...)`), so the status and
   * the launch can never disagree. `subscription` covers both the workspace's own connect and the
   * deployment `CLAUDE_CODE_OAUTH_TOKEN`; `api_key` is the optional env fallback.
   */
  resolveAuthMode(workspaceId: string): Promise<ClaudeAuthModeResult>;
}

/**
 * Claude runtime readiness: connected when a Claude SUBSCRIPTION token is available (the workspace's
 * own connect, or the deployment env `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` — the
 * primary path), or when the optional `ANTHROPIC_API_KEY` fallback is set. Secret-free by
 * construction — this reports the mode and a human reason, never a credential value.
 */
export function createClaudeRuntimeStatusProvider(deps: ClaudeRuntimeStatusDeps): RuntimeStatusProvider {
  return {
    async status(workspaceId) {
      const base = {
        provider: "claude" as const,
        selectedHarness: "claude-code" as const,
        userAuthenticated: true,
        workspaceAuthenticated: true,
        fallback: "none" as const,
      };
      const { mode, reason } = await deps.resolveAuthMode(workspaceId);
      if (mode === "subscription") {
        return {
          ...base,
          connected: true,
          reason: "Claude subscription auth is connected and ready for agent runs.",
          runtimeAuth: "signed_in_subscription",
          authMode: "subscription",
          apiKeySatisfies: false,
        };
      }
      if (mode === "api_key") {
        return {
          ...base,
          connected: true,
          reason: "Anthropic API key fallback (deployment env) is ready for agent runs.",
          runtimeAuth: "api_key",
          authMode: "api_key",
          apiKeySatisfies: true,
        };
      }
      return {
        ...base,
        connected: false,
        // A specific plain-language cause (e.g. a malformed workspace token) fails LOUD here rather
        // than hiding behind the generic connect copy.
        reason:
          reason ??
          "Claude is not connected for this workspace yet. Connect a Claude subscription in " +
            "Settings → Connect Claude, or set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) " +
            "in the server environment.",
        runtimeAuth: "missing",
        authMode: null,
        apiKeySatisfies: false,
      };
    },
  };
}

/** Project the legacy Codex doctor status into the provider-agnostic shape (field-for-field). */
export function runtimeStatusFromCodex(status: CodexSubscriptionStatus): RuntimeStatus {
  // Codex runs are subscription-backed by contract (never an API key), so a connected doctor report
  // maps to the subscription auth mode.
  return { ...status, provider: "codex", authMode: status.connected ? "subscription" : null };
}

/**
 * The ONE provider-agnostic status source the routes + dispatch paths consume: dispatches on the
 * resolved provider, so switching `AGENT_RUNTIME_PROVIDER` re-points every readiness check at once.
 */
export function createRuntimeStatusProvider(
  provider: RuntimeProvider,
  deps: { claude: RuntimeStatusProvider; codex: CodexSubscriptionStatusProvider },
): RuntimeStatusProvider {
  return {
    async status(workspaceId, memberId) {
      if (provider === "codex") {
        return runtimeStatusFromCodex(await deps.codex.status(workspaceId, memberId));
      }
      return deps.claude.status(workspaceId, memberId);
    },
  };
}
