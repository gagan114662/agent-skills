import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { requireChannelCapability } from "../auth/access.js";
import { getWorkspaceMember } from "../db/repositories/members.js";
import { addChannelMember } from "../db/repositories/channels.js";
import { grantCapability } from "../db/repositories/permissions.js";
import { newId } from "../db/id.js";
import type { TeamCoordinator, Subtask } from "../team/coordinator.js";
import { isHarnessKind, type HarnessKind } from "../runtime/harness.js";
import {
  createRuntimeStatusProvider,
  runtimeStatusFromCodex,
  DEFAULT_RUNTIME_PROVIDER,
  type CodexSubscriptionStatus,
  type CodexSubscriptionStatusProvider,
  type RuntimeProvider,
  type RuntimeStatusProvider,
} from "../runtime/provider.js";
import type { TeamArtifactKind } from "@reload/shared";

// Re-exported for existing importers — the canonical home moved to runtime/provider.ts (#1568).
export type { CodexSubscriptionStatus, CodexSubscriptionStatusProvider };

export interface TeamRoutesOptions {
  coordinator: TeamCoordinator;
  /** Resolved runtime provider (#1568). Default `claude`; `codex` restores the legacy posture. */
  runtimeProvider?: RuntimeProvider;
  /** Provider-agnostic readiness source (#1568). When absent, one is derived from the options below. */
  runtimeStatus?: RuntimeStatusProvider;
  /**
   * The deployment's default harness (env `AGENT_HARNESS`) — what a subtask with no explicit pick
   * executes on. Drives the runtime preflight: `demo` (the dev/test default here) never gates, so
   * existing pick-free launches are unchanged; app.ts passes the real resolved value.
   */
  defaultHarness?: HarnessKind;
  /** Claude-specific readiness for the team-run gate (explicit `claude-code` subtask picks). */
  claudeRuntimeStatus?: RuntimeStatusProvider;
  codexSubscription?: CodexSubscriptionStatusProvider;
  staleSessionReaper?: StaleSessionReaper;
}

export interface StaleSessionReaper {
  reap(input: { workspaceId: string; channelId: string }): Promise<StaleSessionReapResult>;
}

export interface StaleSessionReapResult {
  scanned: number;
  reaped: Array<{ sessionId: string; staleForMs: number; canceled: boolean }>;
}

interface SubtaskBody {
  agentMemberId?: string;
  task?: string;
  branch?: string;
  harness?: string;
  phase?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  producesArtifacts?: unknown;
  requiresArtifacts?: unknown;
}

function parseSubtaskPhase(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

const DEFAULT_TEAM_SUBTASK_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TEAM_SUBTASK_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TEAM_SUBTASK_MAX_ATTEMPTS = 2;
const MAX_TEAM_SUBTASK_ATTEMPTS = 3;

function parseSubtaskTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_TEAM_SUBTASK_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.floor(value), MAX_TEAM_SUBTASK_TIMEOUT_MS));
}

function parseSubtaskMaxAttempts(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return DEFAULT_TEAM_SUBTASK_MAX_ATTEMPTS;
  return Math.max(1, Math.min(value, MAX_TEAM_SUBTASK_ATTEMPTS));
}

const TEAM_ARTIFACT_KINDS: readonly TeamArtifactKind[] = ["scout_research", "brand_voice", "draft_set", "lens_review"];

function parseArtifactKinds(value: unknown): TeamArtifactKind[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const kinds: TeamArtifactKind[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !TEAM_ARTIFACT_KINDS.includes(item as TeamArtifactKind)) return null;
    kinds.push(item as TeamArtifactKind);
  }
  return [...new Set(kinds)];
}

/**
 * Team Mode routes — launch N agents in parallel on one feature, each on its own subtask/branch,
 * coordinating over the channel's shared team protocol.
 *
 * Gating reuses #9 channel capabilities + the #19 tenant guard, exactly like #25 agent-sessions:
 * a `write` capability launches; each subtask's agent must be an agent member of THIS workspace
 * (IDOR), and is granted channel membership + write so its streamed output and team events land in
 * the channel. The caller supplies only tasks (data) and branch labels — never a host command.
 */
export async function teamRoutes(app: FastifyInstance, opts: TeamRoutesOptions): Promise<void> {
  const { coordinator } = opts;
  const provider = opts.runtimeProvider ?? DEFAULT_RUNTIME_PROVIDER;
  const codexSubscription = opts.codexSubscription ?? disconnectedCodexSubscription;
  // The ONE readiness source (#1568). A caller that still injects only `codexSubscription` (legacy
  // tests/back-compat) gets a provider-aware wrapper: codex delegates to the doctor probe; claude is
  // fail-closed disconnected until real deps are wired (app.ts always passes `runtimeStatus`).
  // Claude readiness for the gate: an explicitly injected source wins; else, when the deployment
  // provider IS claude, the provider-level `runtimeStatus` is that source; else fail-closed.
  const claudeRuntimeStatus: RuntimeStatusProvider =
    opts.claudeRuntimeStatus ??
    (provider === "claude" && opts.runtimeStatus ? opts.runtimeStatus : disconnectedClaudeRuntime);
  const runtimeStatus: RuntimeStatusProvider =
    opts.runtimeStatus ??
    createRuntimeStatusProvider(provider, {
      claude: claudeRuntimeStatus,
      codex: codexSubscription,
    });
  const staleSessionReaper = opts.staleSessionReaper;

  // Provider-agnostic runtime readiness (#1568): what the dashboard should call going forward.
  app.get("/me/runtime/status", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return runtimeStatus.status(id.workspaceId, id.memberId);
  });

  // Legacy paths (deployed dashboards call these): now served by the SAME provider-agnostic status —
  // the field names are unchanged and `connected`/`reason` keep their meaning, so an older web bundle
  // keeps working when the provider is Claude instead of Codex.
  app.get("/me/codex/status", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return runtimeStatus.status(id.workspaceId, id.memberId);
  });

  app.get("/me/codex/preflight", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return runtimeStatus.status(id.workspaceId, id.memberId);
  });

  // Launch a team run: write capability; every subtask targets an agent member in-workspace.
  app.post("/channels/:channelId/team-runs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { channelId: cid } = req.params as { channelId: string };
    const ch = await requireChannelCapability(id, cid, "write", reply);
    if (!ch) return;
    if (ch.isArchived) return reply.code(409).send({ error: "channel is archived" });

    const body = req.body as { subtasks?: SubtaskBody[] };
    if (!Array.isArray(body.subtasks) || body.subtasks.length === 0) {
      return reply.code(400).send({ error: "subtasks required (non-empty array)" });
    }

    // Validate every subtask up front (all-or-nothing) before mutating any membership.
    const subtasks: Subtask[] = [];
    for (const s of body.subtasks) {
      if (!s.agentMemberId) return reply.code(400).send({ error: "subtask.agentMemberId required" });
      if (!s.task) return reply.code(400).send({ error: "subtask.task required" });
      if (!s.branch) return reply.code(400).send({ error: "subtask.branch required" });
      if (s.harness !== undefined && !isHarnessKind(s.harness)) {
        return reply.code(400).send({ error: "unknown subtask.harness" });
      }
      const producesArtifacts = parseArtifactKinds(s.producesArtifacts);
      if (!producesArtifacts) return reply.code(400).send({ error: "unknown subtask.producesArtifacts" });
      const requiresArtifacts = parseArtifactKinds(s.requiresArtifacts);
      if (!requiresArtifacts) return reply.code(400).send({ error: "unknown subtask.requiresArtifacts" });
      const target = await getWorkspaceMember(s.agentMemberId, id.workspaceId);
      if (!target) return reply.code(404).send({ error: "agent not found in this workspace" });
      if (target.kind !== "agent") {
        return reply.code(400).send({ error: "subtask.agentMemberId must reference an agent member" });
      }
      const phase = parseSubtaskPhase(s.phase);
      const timeoutMs = parseSubtaskTimeoutMs(s.timeoutMs);
      const maxAttempts = parseSubtaskMaxAttempts(s.maxAttempts);
      subtasks.push({
        subtaskId: newId(),
        agentMemberId: target.id,
        task: s.task,
        branch: s.branch,
        ...(phase ? { phase } : {}),
        timeoutMs,
        maxAttempts,
        ...(producesArtifacts.length > 0 ? { producesArtifacts } : {}),
        ...(requiresArtifacts.length > 0 ? { requiresArtifacts } : {}),
        preferredHarness: isHarnessKind(s.harness) ? s.harness : undefined,
      });
    }

    // Runtime preflight (#1568, per-harness): a subtask that will execute on a REAL model harness —
    // an explicit codex/claude-code pick, or no pick (the deployment default fills it in) — must find
    // THAT harness's runtime connected, else the whole run is blocked up front with an actionable 409.
    // `demo` never gates, so pick-free dev/test launches are unchanged.
    const defaultHarness: HarnessKind = opts.defaultHarness ?? "demo";
    const neededHarnesses = new Set(
      subtasks.map((s) => s.preferredHarness ?? defaultHarness).filter((kind) => kind !== "demo"),
    );
    for (const kind of neededHarnesses) {
      const status =
        kind === "codex"
          ? runtimeStatusFromCodex(await codexSubscription.status(id.workspaceId, id.memberId))
          : await claudeRuntimeStatus.status(id.workspaceId, id.memberId);
      if (status.connected) continue;
      req.log.warn(
        {
          event: "runtime_preflight_blocked",
          provider: status.provider,
          workspaceId: id.workspaceId,
          memberId: id.memberId,
          selectedHarness: status.selectedHarness,
          fallback: status.fallback,
          apiKeySatisfies: status.apiKeySatisfies,
          runtimeAuth: status.runtimeAuth,
        },
        "runtime preflight blocked team run",
      );
      return reply.code(409).send({
        error: status.reason,
        // Legacy code kept for the codex harness so existing consumers keep matching on it.
        code: status.provider === "codex" ? "codex_subscription_not_connected" : "runtime_not_connected",
        status,
      });
    }

    const reapResult = await staleSessionReaper
      ?.reap({ workspaceId: id.workspaceId, channelId: cid })
      .catch((err) => {
        req.log.warn(
          { err: err instanceof Error ? err.message : String(err), workspaceId: id.workspaceId, channelId: cid },
          "team run stale-session reap failed",
        );
        return null;
      });

    // Make each agent a legitimate writer in the channel (output + team events land here).
    for (const s of subtasks) {
      await addChannelMember(cid, s.agentMemberId);
      await grantCapability({
        workspaceId: id.workspaceId,
        memberId: s.agentMemberId,
        resourceType: "channel",
        resourceId: cid,
        capability: "write",
        grantedByMemberId: id.memberId,
      });
    }

    const teamRunId = newId();
    // Fire-and-forget: the run continues server-side (like a single agent session). runTeam never
    // rejects — failures are isolated per subtask — but guard the promise just in case.
    void coordinator
      .runTeam({
        workspaceId: id.workspaceId,
        channelId: cid,
        createdByMemberId: id.memberId,
        teamRunId,
        subtasks,
      })
      .catch((err) => {
        app.log.error({ err, teamRunId }, "team run crashed");
      });

    // 201: a durable team run was created; execution continues server-side.
    return reply.code(201).send({
      teamRunId,
      subtaskCount: subtasks.length,
      subtasks: subtasks.map((s) => ({
        subtaskId: s.subtaskId,
        agentMemberId: s.agentMemberId,
        branch: s.branch,
        phase: s.phase ?? 1,
        timeoutMs: s.timeoutMs ?? DEFAULT_TEAM_SUBTASK_TIMEOUT_MS,
        maxAttempts: s.maxAttempts ?? DEFAULT_TEAM_SUBTASK_MAX_ATTEMPTS,
        producesArtifacts: s.producesArtifacts ?? [],
        requiresArtifacts: s.requiresArtifacts ?? [],
        harness: s.preferredHarness ?? null,
      })),
      staleSessionsReaped: reapResult?.reaped ?? [],
    });
  });

  // Read the channel's recent team events (read capability). Optional `?limit=N`.
  app.get("/channels/:cid/team-events", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid } = req.params as { cid: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    const { limit } = req.query as { limit?: string };
    const n = limit ? Number(limit) : undefined;
    const opts = n && Number.isFinite(n) && n > 0 ? { limit: n } : undefined;
    return coordinator.readEvents(cid, opts);
  });

  app.get("/channels/:cid/team-runs/:teamRunId/timeline", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, teamRunId } = req.params as { cid: string; teamRunId: string };
    if (!(await requireChannelCapability(id, cid, "read", reply))) return;
    const timeline = await coordinator.timeline(cid, teamRunId);
    if (timeline.subtaskCount === 0) return reply.code(404).send({ error: "team run not found" });
    return timeline;
  });
}

const disconnectedCodexSubscription: CodexSubscriptionStatusProvider = {
  async status() {
    return {
      connected: false,
      reason:
        "The team engine is not connected to this workspace's signed-in subscription yet. " +
        "Connect subscription auth before starting the agent room.",
      selectedHarness: "codex",
      userAuthenticated: true,
      workspaceAuthenticated: true,
      runtimeAuth: "missing",
      fallback: "none",
      apiKeySatisfies: false,
    };
  },
};

/** Fail-closed Claude readiness for callers that wire no real deps (app.ts always injects one). */
const disconnectedClaudeRuntime: RuntimeStatusProvider = {
  async status() {
    return {
      provider: "claude",
      connected: false,
      reason:
        "Claude is not connected for this workspace yet. Connect a Claude subscription in " +
        "Settings → Connect Claude, or set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) " +
        "in the server environment.",
      selectedHarness: "claude-code",
      userAuthenticated: true,
      workspaceAuthenticated: true,
      runtimeAuth: "missing",
      authMode: null,
      fallback: "none",
      apiKeySatisfies: false,
    };
  },
};
