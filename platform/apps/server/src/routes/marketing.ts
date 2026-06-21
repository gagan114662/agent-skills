import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { SessionManager } from "../runtime/manager.js";
import { listWorkspaceMembers } from "../db/repositories/members.js";
import { listPersonas } from "../db/repositories/personas.js";
import { listLiveSessions } from "../db/repositories/agent-sessions.js";
import { listMarketingTasks } from "../db/repositories/marketing-tasks.js";
import { getMessage } from "../db/repositories/messages.js";
import { buildMarketingRoster } from "../marketing/roster.js";
import { BRAND_VOICE } from "../marketing/blueprint.js";
import {
  seedDepartmentForWorkspace,
  createMarketingMentionService,
  createMarketingBriefService,
} from "../marketing/default.js";
import { resolveMarketingCaps } from "../marketing/caps.js";
import { loadConfig } from "../config/loader.js";

export interface MarketingRoutesOptions {
  sessionManager: SessionManager;
}

/**
 * Marketing Department Fleet routes (#123, ADR-0123). Seed the agency, read the team panel + its task
 * records, and turn an @mention in a department channel into a REAL harness session. The @mention path
 * reuses the audited #59 `SubagentService` gate (via {@link createMarketingMentionService}) over the
 * venture-gated launcher; a launch denial (kill switch / budget) throws an `AdmissionError` that the app
 * error handler maps to 402/429 — so this route deliberately does NOT catch it.
 */
export async function marketingRoutes(app: FastifyInstance, opts: MarketingRoutesOptions): Promise<void> {
  const { sessionManager } = opts;
  const mention = createMarketingMentionService(sessionManager);
  const brief = createMarketingBriefService(sessionManager);

  // Seed the department fleet (idempotent, human-auth). `welcomeTasks` launches a welcome session per
  // department (default off here; signup auto-seed turns it on per the workspace config).
  app.post("/workspaces/:wid/department/seed", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (id.kind !== "human") return reply.code(401).send({ error: "human authentication required" });
    if (!assertWorkspace(id, wid, reply)) return;
    const b = (req.body ?? {}) as { welcomeTasks?: boolean };
    const result = await seedDepartmentForWorkspace(sessionManager, {
      workspaceId: wid,
      createdByMemberId: id.memberId,
      welcomeTasks: b.welcomeTasks === true,
    });
    return reply.code(201).send(result);
  });

  // #235: the owner BRIEFS the fleet. Pick a department lead + a goal ("go get us paying founders for
  // ipop.ai") and this posts the brief into the lead's channel AS the owner and launches a REAL session
  // down the audited @mention path (#68 → #59 → #96 → #71). Human-auth + workspace-scoped. A launch
  // denial (kill switch / budget) bubbles to the app error handler (→ 402/429) — deliberately not caught.
  app.post("/workspaces/:wid/department/brief", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (id.kind !== "human") return reply.code(401).send({ error: "human authentication required" });
    if (!assertWorkspace(id, wid, reply)) return;
    const b = (req.body ?? {}) as { lead?: string; goal?: string };
    if (typeof b.lead !== "string" || typeof b.goal !== "string") {
      return reply.code(400).send({ error: "lead and goal are required" });
    }
    const result = await brief.brief(
      { workspaceId: wid, memberId: id.memberId },
      { lead: b.lead, goal: b.goal },
    );
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    // #439: never return a SILENT no-op. When a brief launched nothing AND no other category explains it
    // (no connect prompt, no model block, no dedup), the launch was gated upstream (most often: the venture
    // isn't active yet). Surface an honest, actionable note instead of an empty 202 the composer can't read.
    const nothingHappened =
      result.launched.length === 0 &&
      result.connectPrompted.length === 0 &&
      result.modelBlocked.length === 0 &&
      result.deduped.length === 0;
    return reply.code(202).send({
      lead: result.lead,
      department: result.department,
      channelId: result.channelId,
      messageId: result.messageId,
      launched: result.launched,
      connectPrompted: result.connectPrompted,
      modelBlocked: result.modelBlocked,
      deduped: result.deduped,
      ...(nothingHappened
        ? {
            note:
              "Your message was posted, but no agent started working on it yet — usually because your " +
              "venture isn't active. Activate your venture (or re-activate) to put the fleet to work.",
          }
        : {}),
    });
  });

  // The team panel: humans + department agents with roles + live presence (#105). Read-only.
  app.get("/workspaces/:wid/department/roster", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const [members, personas, live] = await Promise.all([
      listWorkspaceMembers(wid),
      listPersonas(wid),
      listLiveSessions(),
    ]);
    const liveSessionMemberIds = live.filter((s) => s.workspaceId === wid).map((s) => s.agentMemberId);
    // #166: standing department agents read as online when the fleet is enabled (available to mention),
    // not only during a live session — otherwise they always render grey/offline (QA bug 13).
    const fleetEnabled = resolveMarketingCaps(loadConfig(wid).marketing).enabled;
    const roster = buildMarketingRoster({
      members,
      personas: personas.map((p) => ({ agentMemberId: p.agentMemberId, name: p.name })),
      liveSessionMemberIds,
      fleetEnabled,
    });
    return { ...roster, emptyState: BRAND_VOICE.emptyState, signOff: BRAND_VOICE.signOff };
  });

  // The durable task records (welcome + mention) — the team panel's activity feed.
  app.get("/workspaces/:wid/department/tasks", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return listMarketingTasks(wid);
  });

  // @mention path: launch a REAL session for every department agent @-mentioned on a message, threading
  // each result back under it + recording a task. An admission denial bubbles to the app error handler.
  app.post("/channels/:cid/messages/:mid/marketing", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { cid, mid } = req.params as { cid: string; mid: string };
    const b = (req.body ?? {}) as { task?: string };
    // The message body is the brief (the diff / instruction), exactly like the #59 subagents route.
    const message = await getMessage(mid);
    if (!message || message.channelId !== cid) {
      return reply.code(404).send({ error: "message not found in this channel" });
    }
    const result = await mention.launch(id, { channelId: cid, messageId: mid, task: b.task ?? message.body });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    // #68: `connectPrompted` lists any mentioned agent that couldn't run because the workspace hasn't
    // connected a Claude account — the persona posted a friendly connect prompt instead of launching.
    return reply.code(202).send({
      launched: result.launched,
      connectPrompted: result.connectPrompted,
      // #246: agents skipped because the workspace's fleet model isn't servable — the persona posted a
      // "pick a valid model" prompt instead of launching a doomed session.
      modelBlocked: result.modelBlocked,
    });
  });
}
