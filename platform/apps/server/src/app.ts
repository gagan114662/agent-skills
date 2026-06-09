import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { newId } from "./db/id.js";
import { registerObservability } from "./observability/plugin.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { agentInterfaceRoutes } from "./routes/agent-interface.js";
import { acpRoutes } from "./routes/acp.js";
import { a2aRoutes } from "./routes/a2a.js";
import { agentRoutes } from "./routes/agents.js";
import { channelRoutes } from "./routes/channels.js";
import { notificationRoutes } from "./routes/notifications.js";
import { memoryRoutes } from "./routes/memory.js";
import { taskRoutes } from "./routes/tasks.js";
import { approvalRoutes } from "./routes/approvals.js";
import { agentSessionRoutes } from "./routes/agent-sessions.js";
import {
  integrationsRoutes,
  defaultIntegrationsOptions,
  type IntegrationsRoutesOptions,
} from "./routes/integrations.js";
import { subagentRoutes } from "./routes/subagents.js";
import { gitReviewRoutes } from "./routes/git-review.js";
import { autonomyRoutes } from "./routes/autonomy.js";
import { teamRoutes } from "./routes/team.js";
import { searchRoutes } from "./routes/search.js";
import { mcpRoutes } from "./mcp/http.js";
import { attachRealtime } from "./realtime/gateway.js";
import { createDefaultSessionManager } from "./runtime/default.js";
import type { SessionManager } from "./runtime/manager.js";
import { createGitWorkspaceFromEnv } from "./git/default.js";
import type { GitWorkspaceService } from "./git/workspace.js";
import { createGitHubProvider } from "./github/factory.js";
import type { GitHubProvider } from "./github/provider.js";
import { createDefaultTeamCoordinator } from "./team/default.js";
import type { TeamCoordinator } from "./team/coordinator.js";
import { createDefaultAutonomyEngine } from "./autonomy/default.js";
import type { AutonomyEngine } from "./autonomy/engine.js";

declare module "fastify" {
  interface FastifyInstance {
    /** The #17 autonomy engine; `index.ts` starts its opt-in background timer. */
    autonomyEngine: AutonomyEngine;
  }
}

/**
 * Builds the Fastify app without binding a port, so it can be exercised in tests
 * via `app.inject(...)`. `src/index.ts` calls `listen`.
 *
 * Correlation (#19): `requestIdHeader` makes Fastify adopt an inbound `x-request-id`
 * for traceability across services; `genReqId` falls back to a uuidv7. The id is
 * stamped on every log line (`requestIdLogLabel`) and echoed in the response header
 * by the observability plugin.
 */
/** Options for {@link buildApp}; tests may inject a SessionManager with a fake runtime (#25). */
export interface BuildAppOptions {
  sessionManager?: SessionManager;
  /** Tests inject an AutonomyEngine and drive `tick()` deterministically (#17). */
  autonomyEngine?: AutonomyEngine;
  /** Tests inject a TeamCoordinator over a fake-runtime SessionManager (Team Mode). */
  teamCoordinator?: TeamCoordinator;
  /**
   * #57 deep dev integrations. Tests pass fakes (e.g. a fake IssueProvider, an in-memory config
   * loader); production builds the defaults over the shared SessionManager. Partial — anything
   * omitted falls back to the default.
   */
  integrations?: Partial<IntegrationsRoutesOptions>;
  /** #51 git/PR/review: the worktree+diff service (opt-in; absent → git/PR routes 501). */
  gitWorkspace?: GitWorkspaceService;
  /** #51 git/PR/review: the GitHub provider (tests inject a fake; default `none` from env). */
  gitHubProvider?: GitHubProvider;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: true,
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "requestId",
    genReqId: () => newId(),
  });
  app.register(cookie);
  registerObservability(app);
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(meRoutes);
  // #11 framework-agnostic agent interface: GET /me/channels (capability-filtered) + GET /openapi.json.
  app.register(agentInterfaceRoutes);
  // #12 protocol adapters (grouped with the agent surface): ACP runs ⇄ channel threads, A2A
  // handoff ⇄ tasks + AgentCard handshake. Both reuse the same identity/RBAC/IDOR helpers — no new
  // authority, no new table.
  app.register(acpRoutes);
  app.register(a2aRoutes);
  app.register(agentRoutes);
  app.register(channelRoutes);
  app.register(notificationRoutes);
  app.register(memoryRoutes);
  app.register(taskRoutes);
  // #13 human approval gates: agents submit sensitive actions; humans approve (→ execute) or reject.
  app.register(approvalRoutes);
  app.register(searchRoutes);
  // #10 MCP integration: a stateful Streamable-HTTP MCP server at /mcp. Each tool/resource is a
  // thin adapter over the existing repos + access helpers (no new authority); auth is the existing
  // agent Bearer token (#3) checked per request, and resource subscriptions bridge onto the #5 bus.
  app.register(mcpRoutes);
  // #25 cloud agent execution: the SessionManager owns the agent run server-side (close the
  // laptop, agents keep working). Default backend is `local`; tests may inject a fake-runtime
  // manager. It is cancelled+drained on server close so no run leaks past shutdown.
  const sessionManager = opts.sessionManager ?? createDefaultSessionManager(app.log);
  app.register(agentSessionRoutes, { sessionManager });
  // #57 deep dev integrations: issue→session, project slash commands, agent-config sync. Reuses the
  // same SessionManager and the base-launch gating; provider tokens stay on the #25 secrets path.
  app.register(
    integrationsRoutes,
    defaultIntegrationsOptions(sessionManager, { logger: app.log, ...opts.integrations }),
  );
  // #59 custom subagents / agent personas: define an @-mentionable persona (prompt + tool ceiling),
  // then invoke it in a channel. It runs the real harness AS its own agent member via the same
  // SessionManager, scoped to its tools, with its result threaded under the invoking @mention. The
  // SubagentService is the single RBAC gate (reuses the #9 capability ladder — no new authority).
  app.register(subagentRoutes, { sessionManager });
  app.addHook("onClose", async () => {
    await sessionManager.shutdown();
  });
  // #51 git/PR/diff/review: each session's worktree becomes a reviewable diff + optional GitHub PR,
  // with review comments routed back to the agent as a new session. The git workspace is opt-in
  // (GIT_WORKSPACE_REPO) — absent, the diff/PR routes return 501; the GitHub provider defaults to
  // `none` so CI never calls GitHub. Tests inject a temp-repo git service + a fake provider.
  const gitWorkspace = opts.gitWorkspace ?? createGitWorkspaceFromEnv();
  const gitHubProvider = opts.gitHubProvider ?? createGitHubProvider();
  app.register(gitReviewRoutes, { sessionManager, gitWorkspace, gitHubProvider });
  // Team Mode: run N agents in parallel on one feature, each on its own subtask/branch, kept in
  // the loop over the channel's shared team protocol. The coordinator reuses the same
  // SessionManager (so per-session ResourceCaps still apply) and adds a team-level concurrency cap.
  const teamCoordinator =
    opts.teamCoordinator ?? createDefaultTeamCoordinator(app.log, sessionManager);
  app.register(teamRoutes, { coordinator: teamCoordinator });
  // #17 autonomy: the AutonomyEngine drives the server-owned activity loop (pools, workflows,
  // handoffs, approval gates, guards + kill switch). The background timer is opt-in
  // (AUTONOMY_INTERVAL_MS, default off) and started in index.ts; tests inject the engine and
  // drive `tick()`. It is stopped on server close so no timer leaks past shutdown.
  const autonomyEngine = opts.autonomyEngine ?? createDefaultAutonomyEngine(app.log);
  app.register(autonomyRoutes, { engine: autonomyEngine });
  app.addHook("onClose", async () => {
    autonomyEngine.stop();
  });
  app.decorate("autonomyEngine", autonomyEngine);
  // #5 realtime gateway: WebSocket delivery + presence on top of the REST endpoints.
  // Its Redis subscriber is created lazily on the first socket, so inject-only tests
  // and the no-Redis CI job stay Redis-free.
  attachRealtime(app);
  return app;
}
