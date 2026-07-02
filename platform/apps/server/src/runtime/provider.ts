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
  fallback: "none";
  apiKeySatisfies: boolean;
}

export interface RuntimeStatusProvider {
  status(workspaceId: string, memberId: string): Promise<RuntimeStatus>;
}

export interface ClaudeRuntimeStatusDeps {
  /** Whether this workspace has a connected, well-formed Claude subscription token (#68/#246 vault). */
  hasWorkspaceSubscription(workspaceId: string): Promise<boolean>;
  /** Whether the deployment env carries an Anthropic API key (`ANTHROPIC_API_KEY`) — presence only, never the value. */
  hasEnvApiKey(): boolean;
}

/**
 * Claude runtime readiness: connected when the workspace's own subscription token is on file, OR when
 * the deployment env provides `ANTHROPIC_API_KEY` (the owner-set Fly secret). Secret-free by
 * construction — this reports presence booleans and a human reason, never a credential value.
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
      if (await deps.hasWorkspaceSubscription(workspaceId)) {
        return {
          ...base,
          connected: true,
          reason: "Claude subscription auth is connected and ready for agent runs.",
          runtimeAuth: "signed_in_subscription",
          apiKeySatisfies: false,
        };
      }
      if (deps.hasEnvApiKey()) {
        return {
          ...base,
          connected: true,
          reason: "Anthropic API key auth (deployment env) is ready for agent runs.",
          runtimeAuth: "api_key",
          apiKeySatisfies: true,
        };
      }
      return {
        ...base,
        connected: false,
        reason:
          "Claude is not connected for this workspace yet. Connect a Claude subscription in " +
          "Settings → Connect Claude, or set ANTHROPIC_API_KEY in the server environment.",
        runtimeAuth: "missing",
        apiKeySatisfies: false,
      };
    },
  };
}

/** Project the legacy Codex doctor status into the provider-agnostic shape (field-for-field). */
export function runtimeStatusFromCodex(status: CodexSubscriptionStatus): RuntimeStatus {
  return { ...status, provider: "codex" };
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
