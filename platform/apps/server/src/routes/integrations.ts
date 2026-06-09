import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import type { SessionManager } from "../runtime/manager.js";
import { EnvSecretsResolver, type SecretsResolver } from "../runtime/secrets-resolver.js";
import type { ResolvedConfig } from "../config/schema.js";
import { loadConfig as defaultLoadConfig } from "../config/loader.js";
import { gateChannelLaunch } from "../integrations/session-launch.js";
import { buildIssueTask, parseIssueRef } from "../integrations/issues/types.js";
import {
  PROVIDER_TOKEN_KEYS,
  resolveIssueProvider,
  defaultIssueProviders,
  type IssueProviders,
} from "../integrations/issues/registry.js";
import {
  SlashCommandRegistry,
  expandCommand,
  parseSlashInput,
} from "../integrations/commands/slash.js";
import { toAgentConfig } from "../integrations/config-sync/canonical.js";
import { planSync, type HarnessTarget } from "../integrations/config-sync/exporters.js";

const SYNC_TARGETS: HarnessTarget[] = ["claude-code", "codex"];

/** Deps for the #57 dev-integration routes. Tests inject fakes (no network, fake SessionManager). */
export interface IntegrationsRoutesOptions {
  sessionManager: SessionManager;
  secrets: SecretsResolver;
  issueProviders: IssueProviders;
  /** Resolve the per-tenant layered config. Defaults to the real loader. */
  loadConfig?: (workspaceId?: string) => ResolvedConfig;
  /** Optional logger for best-effort link-back comment failures. */
  logger?: { warn(obj: unknown, msg?: string): void };
}

/** Build the default integration deps over a shared SessionManager (used by `buildApp`). */
export function defaultIntegrationsOptions(
  sessionManager: SessionManager,
  overrides: Partial<IntegrationsRoutesOptions> = {},
): IntegrationsRoutesOptions {
  return {
    sessionManager,
    // Same env-backed per-tenant resolver the SessionManager uses (#25); tokens never leave this path.
    secrets: overrides.secrets ?? new EnvSecretsResolver(),
    issueProviders: overrides.issueProviders ?? defaultIssueProviders(),
    loadConfig: overrides.loadConfig ?? ((wid) => defaultLoadConfig(wid)),
    logger: overrides.logger,
  };
}

/**
 * Deep dev integrations (#57): start a session from a GitHub/Linear issue, run a project slash
 * command in a session, and sync the canonical agent-config to each harness. All session launches
 * reuse the base `agent-sessions.ts` gating via {@link gateChannelLaunch} — no new authority. Provider
 * tokens are resolved per-tenant from the #25 `SecretsResolver`, used only as the bearer arg, and never
 * logged or written to config/artifacts.
 */
export async function integrationsRoutes(
  app: FastifyInstance,
  opts: IntegrationsRoutesOptions,
): Promise<void> {
  const { sessionManager, secrets, issueProviders } = opts;
  const loadConfig = opts.loadConfig ?? ((wid) => defaultLoadConfig(wid));

  // --- Issue → session (read context + optional act/comment) ---
  app.post("/channels/:cid/agent-sessions/from-issue", async (req, reply) => {
    const { cid } = req.params as { cid: string };
    const b = req.body as {
      ref?: string;
      agentMemberId?: string;
      linkBack?: boolean;
      instructions?: string;
    };
    if (!b.ref) return reply.code(400).send({ error: "ref required" });

    // Parse the ref before granting anything (cheap, non-sensitive format validation).
    let ref;
    try {
      ref = parseIssueRef(b.ref);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    const gate = await gateChannelLaunch(req, reply, cid, b.agentMemberId);
    if (!gate) return;

    // Resolve the provider's token per-tenant; it is used only as the bearer arg, never logged.
    const provider = resolveIssueProvider(ref, issueProviders);
    const resolved = await secrets.resolve(gate.workspaceId);
    const token = resolved[PROVIDER_TOKEN_KEYS[ref.source]];

    let ctx;
    try {
      ctx = await provider.fetchIssue(ref, token);
    } catch {
      // Never echo the provider error (could carry request internals); generic 502.
      return reply.code(502).send({ error: `failed to fetch ${ref.source} issue` });
    }

    const task = buildIssueTask(ctx, b.instructions);
    const session = await sessionManager.launch({
      workspaceId: gate.workspaceId,
      channelId: gate.channelId,
      agentMemberId: gate.agentMemberId,
      createdByMemberId: gate.byMemberId,
      task,
    });

    // The "act": link the session back to the issue. Best-effort — a failed comment never fails an
    // already-launched session.
    if (b.linkBack) {
      void provider
        .postComment(ref, token, `🤖 Reload session ${session.id} started for this issue.`)
        .catch((err) => opts.logger?.warn({ err: String(err) }, "issue link-back comment failed"));
    }

    return reply.code(202).send({
      id: session.id,
      status: session.status,
      runtime: session.runtime,
      agentMemberId: session.agentMemberId,
      issue: { source: ctx.source, ref: ctx.ref, url: ctx.url, title: ctx.title },
    });
  });

  // --- Project slash command → session ---
  app.post("/channels/:cid/agent-sessions/slash", async (req, reply) => {
    const { cid } = req.params as { cid: string };
    const b = req.body as { command?: string; agentMemberId?: string };
    if (!b.command) return reply.code(400).send({ error: "command required" });

    let parsed;
    try {
      parsed = parseSlashInput(b.command);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    const gate = await gateChannelLaunch(req, reply, cid, b.agentMemberId);
    if (!gate) return;

    const registry = new SlashCommandRegistry(loadConfig(gate.workspaceId).slashCommands);
    let cmd;
    try {
      cmd = registry.get(parsed.name);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }

    // The template is trusted config; the caller's args are data interpolated into the prompt text.
    const task = expandCommand(cmd, parsed.args);
    const session = await sessionManager.launch({
      workspaceId: gate.workspaceId,
      channelId: gate.channelId,
      agentMemberId: gate.agentMemberId,
      createdByMemberId: gate.byMemberId,
      task,
    });

    return reply.code(202).send({
      id: session.id,
      status: session.status,
      runtime: session.runtime,
      agentMemberId: session.agentMemberId,
      command: cmd.name,
    });
  });

  // --- Agent-config sync across harnesses ---
  app.get("/me/agent-config", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return toAgentConfig(loadConfig(id.workspaceId));
  });

  app.post("/me/agent-config/sync", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const b = req.body as { targets?: string[] };
    let targets = SYNC_TARGETS;
    if (b.targets) {
      const invalid = b.targets.filter((t) => !SYNC_TARGETS.includes(t as HarnessTarget));
      if (invalid.length) return reply.code(400).send({ error: `unknown targets: ${invalid.join(", ")}` });
      targets = b.targets as HarnessTarget[];
    }
    const plan = planSync(toAgentConfig(loadConfig(id.workspaceId)), targets);
    return { targets, artifacts: plan.artifacts };
  });
}
