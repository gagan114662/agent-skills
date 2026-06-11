import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { getChannel } from "../db/repositories/channels.js";
import { departmentForChannel } from "../marketing/blueprint.js";
import { TASK_TEMPLATES, templatesForDepartment, getTemplate } from "../automations/templates.js";
import { computeNextRun } from "../automations/schedule.js";
import { generateWebhookToken, hashWebhookToken } from "../automations/webhook.js";
import { isTriggerKind, type ScheduleSpec, CADENCES } from "../automations/types.js";
import { resolveAutomationCaps } from "../automations/caps.js";
import { loadConfig } from "../config/loader.js";
import { listAutomationRuns } from "../db/repositories/automations.js";
import type { AutomationEngine, AutomationStore } from "../automations/engine.js";

/**
 * Automations + task-template-gallery routes (#147, ADR-0147) under `/workspaces/:wid`. Thin adapters
 * over the {@link AutomationStore} (CRUD, tenant-scoped via the #19 `assertWorkspace` boundary) and the
 * {@link AutomationEngine} (`runAutomation` for run-now + webhook). The public webhook route carries no
 * workspace guard — it authenticates by the token hash and resolves the automation's own workspace.
 */
export interface AutomationRoutesOptions {
  engine: AutomationEngine;
  store: AutomationStore;
}

/** Coerce a request body's schedule bag into a typed {@link ScheduleSpec}, or null if invalid. */
function readSchedule(raw: unknown): ScheduleSpec | null {
  const s = (raw ?? {}) as Record<string, unknown>;
  if (typeof s.cadence !== "string" || !(CADENCES as readonly string[]).includes(s.cadence)) return null;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  return {
    cadence: s.cadence as ScheduleSpec["cadence"],
    everyMinutes: num(s.everyMinutes),
    dayOfWeek: num(s.dayOfWeek),
    hour: num(s.hour),
    minute: num(s.minute),
  };
}

function readParams(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

export async function automationRoutes(app: FastifyInstance, opts: AutomationRoutesOptions): Promise<void> {
  const { engine, store } = opts;

  /** The task-template gallery for a channel's #123 department (or all templates if no channel). */
  app.get("/workspaces/:wid/task-templates", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const { channel } = req.query as { channel?: string };
    if (channel) {
      const ch = await getChannel(channel);
      if (!ch || ch.workspaceId !== wid) return reply.code(404).send({ error: "channel not found" });
      const dept = departmentForChannel(ch.name ?? "");
      // Attach the channel department's agent handle so the composer can pre-fill an @mention launch.
      return dept ? templatesForDepartment(dept.key).map((t) => ({ ...t, agentHandle: dept.agent.handle })) : [];
    }
    return TASK_TEMPLATES;
  });

  /** The workspace's automations (newest first). */
  app.get("/workspaces/:wid/automations", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return store.list(wid);
  });

  /** Define a new automation. A webhook trigger returns its token ONCE (shown like an API key). */
  app.post("/workspaces/:wid/automations", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as {
      name?: string;
      triggerKind?: string;
      schedule?: unknown;
      templateKey?: string;
      params?: unknown;
      channelId?: string;
      agentHandle?: string;
      enabled?: boolean;
    };
    if (!body.name) return reply.code(400).send({ error: "name is required" });
    if (!isTriggerKind(body.triggerKind)) {
      return reply.code(400).send({ error: "triggerKind must be 'schedule' or 'webhook'" });
    }
    if (!body.templateKey || !getTemplate(body.templateKey)) {
      return reply.code(400).send({ error: "templateKey must reference a known template" });
    }
    if (!body.channelId) return reply.code(400).send({ error: "channelId is required" });
    const channel = await getChannel(body.channelId);
    if (!channel || channel.workspaceId !== wid) {
      return reply.code(404).send({ error: "channel not found" });
    }

    // The persona handle: explicit, else the channel department's agent.
    const dept = departmentForChannel(channel.name ?? "");
    const agentHandle = body.agentHandle ?? dept?.agent.handle;
    if (!agentHandle) return reply.code(400).send({ error: "agentHandle is required (no department for channel)" });

    let schedule: ScheduleSpec | null = null;
    if (body.triggerKind === "schedule") {
      schedule = readSchedule(body.schedule);
      if (!schedule) return reply.code(400).send({ error: "a schedule trigger requires a valid cadence" });
    }

    // Enforce the per-tenant definition cap (config; the engine enforces the run-time rate cap).
    const caps = resolveAutomationCaps(loadConfig(wid).automations);
    if ((await store.countForWorkspace(wid)) >= caps.maxPerWorkspace) {
      return reply.code(429).send({ error: "automation limit reached" });
    }

    const enabled = body.enabled ?? false;
    const now = new Date();
    const nextRunAt = enabled && schedule ? computeNextRun(schedule, now) : null;

    let token: string | undefined;
    let webhookTokenHash: string | null = null;
    if (body.triggerKind === "webhook") {
      const minted = generateWebhookToken();
      token = minted.token;
      webhookTokenHash = minted.hash;
    }

    const record = await store.create({
      workspaceId: wid,
      name: body.name,
      triggerKind: body.triggerKind,
      schedule,
      webhookTokenHash,
      templateKey: body.templateKey,
      params: readParams(body.params),
      channelId: body.channelId,
      agentHandle,
      enabled,
      createdByMemberId: id.memberId,
      nextRunAt,
    });
    // The token is shown ONCE — never persisted in plaintext, never returned again.
    return reply.code(201).send(token ? { ...record, webhookToken: token } : record);
  });

  /** Pause / resume an automation. Enabling a schedule trigger recomputes its cursor from now. */
  app.post("/workspaces/:wid/automations/:id/enable", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: automationId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const enabled = Boolean((req.body as { enabled?: boolean } | undefined)?.enabled ?? true);

    const current = await store.get(wid, automationId);
    if (!current) return reply.code(404).send({ error: "automation not found" });
    const nextRunAt = enabled && current.schedule ? computeNextRun(current.schedule, new Date()) : null;
    const updated = await store.setEnabled(wid, automationId, enabled, nextRunAt);
    return updated ?? reply.code(404).send({ error: "automation not found" });
  });

  /** Delete an automation (its run ledger cascades). */
  app.delete("/workspaces/:wid/automations/:id", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: automationId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const ok = await store.remove(wid, automationId);
    return ok ? reply.code(204).send() : reply.code(404).send({ error: "automation not found" });
  });

  /** Run an automation now (manual trigger). Honors the same default-OFF caps as the scheduler. */
  app.post("/workspaces/:wid/automations/:id/run", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: automationId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const automation = await store.get(wid, automationId);
    if (!automation) return reply.code(404).send({ error: "automation not found" });
    const run = await engine.runAutomation(automation, "manual");
    return reply.code(202).send(run);
  });

  /** The workspace's run ledger (the audit-trail / console source), newest first. */
  app.get("/workspaces/:wid/automations/:id/runs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: automationId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const automation = await store.get(wid, automationId);
    if (!automation) return reply.code(404).send({ error: "automation not found" });
    return (await listAutomationRuns(wid)).filter((r) => r.automationId === automationId);
  });

  /**
   * Public webhook trigger. Authenticated by the token hash (no workspace guard) — resolves the
   * automation's own workspace. Default-OFF + the automation's `enabled` flag still gate execution.
   */
  app.post("/automations/hooks/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const automation = await store.findByWebhookHash(hashWebhookToken(token));
    if (!automation || automation.triggerKind !== "webhook") {
      return reply.code(404).send({ error: "unknown webhook" });
    }
    const run = await engine.runAutomation(automation, "webhook");
    return reply.code(202).send({ id: run.id, status: run.status, reason: run.reason });
  });
}
