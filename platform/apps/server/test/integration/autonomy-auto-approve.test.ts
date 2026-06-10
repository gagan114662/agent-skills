import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { dbStore, channelPoster } from "../../src/runtime/default.js";
import { SessionManager } from "../../src/runtime/manager.js";
import type { SessionLogger } from "../../src/runtime/manager.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { AutonomyEngine } from "../../src/autonomy/engine.js";
import { autonomyLauncherFrom } from "../../src/autonomy/default.js";
import { listPolicyRulesWithId } from "../../src/db/repositories/approvals.js";
import type {
  AgentJob,
  AgentRuntime,
  RunningSession,
  RuntimeHooks,
  RuntimeResult,
} from "../../src/runtime/types.js";

/**
 * ADR-0042 follow-up (#84) — the explicit **auto-approve policy rule** for autonomous completion.
 *
 * The engine is wired with a completion-policy source (the #13 `approval_policies` store, reused) so
 * a workspace can opt a trusted workflow out of the human gate with an `autonomy.complete` rule. With
 * no rule the human gate still holds (the same behaviour as `autonomy-launch.test.ts`). Real Postgres
 * + Redis, a fake runtime (no cloud / no harness). Proves: rule → auto-approved → done with an audit
 * record of which rule fired, and that the rule is per-workspace (no cross-tenant leakage).
 */

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A runtime that emits one line and completes successfully. */
class CompletingRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  start(job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession> {
    hooks.onOutput("stdout", "autonomous work done\n");
    return Promise.resolve<RunningSession>({
      sessionId: job.sessionId,
      wait: () => Promise.resolve<RuntimeResult>({ status: "completed", exitCode: 0 }),
      cancel: () => Promise.resolve(),
    });
  }
}

/** An engine whose completed-final-stage path consults the workspace's autonomy.complete policy. */
function makeEngine(): AutonomyEngine {
  const sessionManager = new SessionManager({
    runtime: new CompletingRuntime(),
    store: dbStore,
    poster: channelPoster,
    secrets: new StaticSecretsResolver({}),
    harness: { command: "bash", args: ["agent.sh"] },
    caps: { wallClockMs: 10_000, idleMs: 10_000 },
    logger: silentLogger,
  });
  return new AutonomyEngine({
    poster: channelPoster,
    logger: silentLogger,
    launcher: autonomyLauncherFrom(sessionManager),
    completionPolicies: (workspaceId) => listPolicyRulesWithId(workspaceId),
  });
}

const slugs: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await Promise.allSettled(apps.map((a) => a.close()));
  await Promise.allSettled([closeDb(), closeRedis()]);
});

const post = (app: ReturnType<typeof buildApp>, url: string, cookie: string, payload?: unknown) =>
  app.inject({ method: "POST", url, cookies: { rid: cookie }, payload: payload as object });
const put = (app: ReturnType<typeof buildApp>, url: string, cookie: string, payload?: unknown) =>
  app.inject({ method: "PUT", url, cookies: { rid: cookie }, payload: payload as object });
const get = (app: ReturnType<typeof buildApp>, url: string, cookie: string) =>
  app.inject({ method: "GET", url, cookies: { rid: cookie } });

interface Tenant {
  cookie: string;
  workspaceId: string;
  channelId: string;
  researcher: string;
}

/** Sign up a fresh workspace under `app`, with one pooled + autonomy-enabled researcher agent. */
async function provision(app: ReturnType<typeof buildApp>): Promise<Tenant> {
  const slug = `aua-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await get(app, "/me", cookie)).json();
  const channel = (
    await post(app, `/workspaces/${me.workspaceId}/channels`, cookie, { name: "team-a" })
  ).json();
  const researcher = (
    await post(app, `/workspaces/${me.workspaceId}/agents`, cookie, { name: "Researcher" })
  ).json();
  const pool = (
    await post(app, `/workspaces/${me.workspaceId}/agent-pools`, cookie, { name: `pool-${newId()}` })
  ).json();
  await post(app, `/workspaces/${me.workspaceId}/agent-pools/${pool.id}/agents`, cookie, {
    agentMemberId: researcher.memberId,
    roles: ["researcher"],
  });
  await put(app, `/workspaces/${me.workspaceId}/agents/${researcher.memberId}/autonomy`, cookie, {
    enabled: true,
    maxActionsPerTick: 5,
    actionBudget: 100,
  });
  return { cookie, workspaceId: me.workspaceId, channelId: channel.id, researcher: researcher.memberId };
}

async function createWorkflow(
  app: ReturnType<typeof buildApp>,
  t: Tenant,
  title: string,
): Promise<{ taskId: string; wfId: string }> {
  const taskId = (await post(app, `/workspaces/${t.workspaceId}/tasks`, t.cookie, { title })).json()
    .id as string;
  const wf = (
    await post(app, `/channels/${t.channelId}/workflows`, t.cookie, {
      taskId,
      stages: [{ agentMemberId: t.researcher, role: "researcher" }],
    })
  ).json();
  return { taskId, wfId: wf.id };
}

describe("auto-approve policy rule for autonomous completion (#84 follow-up, ADR-0042)", () => {
  it("tick → launch → complete → auto-approve → done, with an audit record of which rule fired", async () => {
    const engine = makeEngine();
    const app = buildApp({ autonomyEngine: engine });
    apps.push(app);
    const t = await provision(app);

    // Opt this workspace out of the human gate via the existing #13 policy route + storage.
    const rule = (
      await post(app, `/workspaces/${t.workspaceId}/approval-policies`, t.cookie, {
        actionType: "autonomy.complete",
        requireApproval: false,
      })
    ).json() as { id: string };
    expect(rule.id).toBeTruthy();

    const { taskId, wfId } = await createWorkflow(app, t, "summarize the repo");

    await engine.tick(t.workspaceId);
    await engine.drain();

    // The loop closed to done WITHOUT a human — auto-approved by the policy rule.
    expect((await get(app, `/tasks/${taskId}`, t.cookie)).json().status).toBe("done");
    expect((await get(app, `/channels/${t.channelId}/workflows/${wfId}`, t.cookie)).json().status).toBe(
      "completed",
    );
    // No request is left dangling at the gate.
    const pending = (
      await get(app, `/workspaces/${t.workspaceId}/autonomy/approvals?status=pending`, t.cookie)
    ).json() as unknown[];
    expect(pending).toHaveLength(0);

    // The approval carries the audit: decided by policy, naming the rule that fired.
    const approved = (
      await get(app, `/workspaces/${t.workspaceId}/autonomy/approvals?status=approved`, t.cookie)
    ).json() as { decisionSource: string; policyRuleId: string | null }[];
    expect(approved).toHaveLength(1);
    expect(approved[0].decisionSource).toBe("policy");
    expect(approved[0].policyRuleId).toBe(rule.id);

    const bodies = ((await get(app, `/channels/${t.channelId}/messages`, t.cookie)).json() as {
      body: string;
    }[]).map((m) => m.body);
    expect(bodies.some((b) => b.includes("auto-approved"))).toBe(true);
  });

  it("the rule is per-workspace: a rule in workspace A never auto-approves workspace B", async () => {
    const engine = makeEngine();
    const app = buildApp({ autonomyEngine: engine });
    apps.push(app);
    const a = await provision(app);
    const b = await provision(app);

    // Only workspace A configures the auto-approve rule.
    await post(app, `/workspaces/${a.workspaceId}/approval-policies`, a.cookie, {
      actionType: "autonomy.complete",
      requireApproval: false,
    });

    const wfA = await createWorkflow(app, a, "A: summarize");
    const wfB = await createWorkflow(app, b, "B: summarize");

    await engine.tick(a.workspaceId);
    await engine.tick(b.workspaceId);
    await engine.drain();

    // A is auto-approved to done; B still parks at the human gate (no rule leaked across tenants).
    expect((await get(app, `/tasks/${wfA.taskId}`, a.cookie)).json().status).toBe("done");
    expect(
      (await get(app, `/channels/${b.channelId}/workflows/${wfB.wfId}`, b.cookie)).json().status,
    ).toBe("awaiting_approval");
    expect((await get(app, `/tasks/${wfB.taskId}`, b.cookie)).json().status).toBe("in_progress");
    const pendingB = (
      await get(app, `/workspaces/${b.workspaceId}/autonomy/approvals?status=pending`, b.cookie)
    ).json() as unknown[];
    expect(pendingB).toHaveLength(1);
  });
});
