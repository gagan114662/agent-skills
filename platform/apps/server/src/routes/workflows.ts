import type { FastifyInstance, FastifyReply } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { computeNextRun } from "../automations/schedule.js";
import { generateWebhookToken, hashWebhookToken } from "../automations/webhook.js";
import { resolveWorkflowCaps } from "../workflows/caps.js";
import { aggregateWorkflowInsights } from "../workflows/insights.js";
import { buildLaunchPlaybook, isLaunchChannel, type LaunchChannel } from "../workflows/launch-playbook.js";
import {
  isWorkflowTriggerKind,
  isConditionOp,
  isWorkflowActionKind,
  type WorkflowAction,
  type WorkflowCondition,
  type WorkflowTrigger,
} from "../workflows/types.js";
import { isMarketingSendKind } from "../marketing/external-send.js";
import { CADENCES, type ScheduleSpec } from "../automations/types.js";
import type { WorkflowEngine, WorkflowStore } from "../workflows/engine.js";

/**
 * Visual workflow builder routes (#152, ADR-0152) under `/workspaces/:wid`. Thin adapters over the
 * {@link WorkflowStore} (CRUD, tenant-scoped via the #19 `assertWorkspace` boundary) and the
 * {@link WorkflowEngine} (`runWorkflow` for run-now + webhook). Every route except the public webhook is
 * identity-gated; the webhook authenticates by token hash and resolves the workflow's own workspace.
 * Creating a workflow is always allowed (it cannot fire until the `workflows` config is enabled), so
 * these CRUD routes are NOT flag-gated — the firing path is what the flag controls.
 */
export interface WorkflowRoutesOptions {
  engine: WorkflowEngine;
  store: WorkflowStore;
}

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

/** Validate + normalize the trigger bag. Returns the trigger or an error string. */
function readTrigger(raw: unknown): { trigger: WorkflowTrigger } | { error: string } {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (!isWorkflowTriggerKind(t.kind)) {
    return { error: "trigger.kind must be schedule/webhook/catalog_change/channel_event" };
  }
  const trigger: WorkflowTrigger = { kind: t.kind };
  if (t.kind === "schedule") {
    const schedule = readSchedule(t.schedule);
    if (!schedule) return { error: "a schedule trigger requires a valid cadence" };
    trigger.schedule = schedule;
  }
  if (t.kind === "catalog_change" && typeof t.catalogKind === "string") trigger.catalogKind = t.catalogKind as never;
  if (t.kind === "channel_event" && typeof t.channelId === "string") trigger.channelId = t.channelId;
  return { trigger };
}

/** Validate + normalize the conditions array. Returns the list or an error string. */
function readConditions(raw: unknown): { conditions: WorkflowCondition[] } | { error: string } {
  if (raw === undefined) return { conditions: [] };
  if (!Array.isArray(raw)) return { error: "conditions must be an array" };
  const conditions: WorkflowCondition[] = [];
  for (const c of raw) {
    const obj = (c ?? {}) as Record<string, unknown>;
    if (typeof obj.fact !== "string" || !isConditionOp(obj.op)) {
      return { error: "each condition needs a fact (string) and a valid op" };
    }
    const cond: WorkflowCondition = { fact: obj.fact, op: obj.op };
    if (typeof obj.value === "string" || typeof obj.value === "number" || typeof obj.value === "boolean") {
      cond.value = obj.value;
    }
    conditions.push(cond);
  }
  return { conditions };
}

/** Validate + normalize the actions array. Returns the list or an error string. */
function readActions(raw: unknown): { actions: WorkflowAction[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "at least one action is required" };
  const actions: WorkflowAction[] = [];
  for (const a of raw) {
    const obj = (a ?? {}) as Record<string, unknown>;
    if (!isWorkflowActionKind(obj.kind)) return { error: "each action needs a valid kind" };
    const action: WorkflowAction = { kind: obj.kind };
    if (obj.kind === "agent_task") {
      if (typeof obj.channelId !== "string") return { error: "agent_task needs a channelId" };
      action.channelId = obj.channelId;
      if (typeof obj.agentHandle === "string") action.agentHandle = obj.agentHandle;
      if (typeof obj.templateKey === "string") action.templateKey = obj.templateKey;
      if (typeof obj.task === "string") action.task = obj.task;
      if (obj.params && typeof obj.params === "object") {
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj.params as Record<string, unknown>)) {
          if (typeof v === "string") params[k] = v;
        }
        action.params = params;
      }
      if (!action.templateKey && !action.task) return { error: "agent_task needs a templateKey or task" };
    } else if (obj.kind === "draft_send") {
      if (!isMarketingSendKind(obj.sendKind)) return { error: "draft_send needs a valid sendKind" };
      if (typeof obj.summary !== "string" || !obj.summary.trim()) return { error: "draft_send needs a summary" };
      action.sendKind = obj.sendKind;
      action.summary = obj.summary.trim();
      if (typeof obj.target === "string") action.target = obj.target;
      if (typeof obj.amountCents === "number") action.amountCents = obj.amountCents;
    } else if (obj.kind === "notify_owner") {
      if (typeof obj.message === "string") action.message = obj.message;
    }
    actions.push(action);
  }
  return { actions };
}

export async function workflowRoutes(app: FastifyInstance, opts: WorkflowRoutesOptions): Promise<void> {
  const { engine, store } = opts;

  /** The workspace's workflows (newest first). */
  app.get("/workspaces/:wid/workflows", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return store.list(wid);
  });

  /** Define a new workflow. A webhook trigger returns its token ONCE (shown like an API key). */
  app.post("/workspaces/:wid/workflows", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.name !== "string" || !body.name.trim()) {
      return reply.code(400).send({ error: "name is required" });
    }
    const trig = readTrigger(body.trigger);
    if ("error" in trig) return reply.code(400).send({ error: trig.error });
    const conds = readConditions(body.conditions);
    if ("error" in conds) return reply.code(400).send({ error: conds.error });
    const acts = readActions(body.actions);
    if ("error" in acts) return reply.code(400).send({ error: acts.error });

    const caps = resolveWorkflowCaps(loadConfig(wid).workflows);
    if ((await store.countForWorkspace(wid)) >= caps.maxPerWorkspace) {
      return reply.code(429).send({ error: "workflow limit reached" });
    }

    const enabled = body.enabled === true;
    const now = new Date();
    const nextRunAt =
      enabled && trig.trigger.kind === "schedule" && trig.trigger.schedule
        ? computeNextRun(trig.trigger.schedule, now)
        : null;

    let token: string | undefined;
    let webhookTokenHash: string | null = null;
    if (trig.trigger.kind === "webhook") {
      const minted = generateWebhookToken();
      token = minted.token;
      webhookTokenHash = minted.hash;
    }

    const record = await store.create({
      workspaceId: wid,
      name: body.name.trim(),
      triggerKind: trig.trigger.kind,
      trigger: trig.trigger,
      conditions: conds.conditions,
      actions: acts.actions,
      webhookTokenHash,
      enabled,
      createdByMemberId: id.memberId,
      nextRunAt,
    });
    return reply.code(201).send(token ? { ...record, webhookToken: token } : record);
  });

  /** Create and optionally run the reusable launch-day coordination playbook (#600). */
  app.post("/workspaces/:wid/workflows/launch-playbook", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.name !== "string" || !body.name.trim()) {
      return reply.code(400).send({ error: "name is required" });
    }
    if (typeof body.channelId !== "string" || !body.channelId.trim()) {
      return reply.code(400).send({ error: "channelId is required" });
    }
    const launchAt = typeof body.launchAt === "string" ? new Date(body.launchAt) : null;
    if (!launchAt || Number.isNaN(launchAt.getTime())) {
      return reply.code(400).send({ error: "launchAt must be an ISO timestamp" });
    }
    const channels: LaunchChannel[] = [];
    if (body.channels !== undefined) {
      if (!Array.isArray(body.channels)) return reply.code(400).send({ error: "channels must be an array" });
      for (const channel of body.channels) {
        if (!isLaunchChannel(channel)) return reply.code(400).send({ error: "unknown launch channel" });
        channels.push(channel);
      }
    }

    const caps = resolveWorkflowCaps(loadConfig(wid).workflows);
    if ((await store.countForWorkspace(wid)) >= caps.maxPerWorkspace) {
      return reply.code(429).send({ error: "workflow limit reached" });
    }

    const playbook = buildLaunchPlaybook({
      name: body.name,
      launchAt,
      channelId: body.channelId,
      channels: channels.length > 0 ? channels : undefined,
      ownerMessage: typeof body.ownerMessage === "string" ? body.ownerMessage : undefined,
    });
    const minted = generateWebhookToken();
    const record = await store.create({
      workspaceId: wid,
      name: playbook.workflow.name,
      triggerKind: playbook.workflow.trigger.kind,
      trigger: playbook.workflow.trigger,
      conditions: playbook.workflow.conditions,
      actions: playbook.workflow.actions,
      webhookTokenHash: minted.hash,
      enabled: playbook.workflow.enabled,
      createdByMemberId: id.memberId,
      nextRunAt: null,
    });
    const run = body.runNow === false ? null : await engine.runWorkflow(record, "manual");
    return reply.code(201).send({ workflow: { ...record, webhookToken: minted.token }, checklist: playbook.checklist, run });
  });

  /** Pause / resume a workflow. Enabling a schedule trigger recomputes its cursor from now. */
  app.post("/workspaces/:wid/workflows/:id/enable", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: workflowId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const enabled = Boolean((req.body as { enabled?: boolean } | undefined)?.enabled ?? true);

    const current = await store.get(wid, workflowId);
    if (!current) return reply.code(404).send({ error: "workflow not found" });
    const nextRunAt =
      enabled && current.trigger.kind === "schedule" && current.trigger.schedule
        ? computeNextRun(current.trigger.schedule, new Date())
        : null;
    const updated = await store.setEnabled(wid, workflowId, enabled, nextRunAt);
    return updated ?? reply.code(404).send({ error: "workflow not found" });
  });

  /** Delete a workflow (its run ledger cascades). */
  app.delete("/workspaces/:wid/workflows/:id", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: workflowId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const ok = await store.remove(wid, workflowId);
    return ok ? reply.code(204).send() : reply.code(404).send({ error: "workflow not found" });
  });

  /** Run a workflow now (manual trigger). Honors the same default-OFF caps + conditions as the tick. */
  app.post("/workspaces/:wid/workflows/:id/run", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: workflowId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const workflow = await store.get(wid, workflowId);
    if (!workflow) return reply.code(404).send({ error: "workflow not found" });
    const run = await engine.runWorkflow(workflow, "manual");
    return reply.code(202).send(run);
  });

  /** A single workflow's run ledger (newest first). */
  app.get("/workspaces/:wid/workflows/:id/runs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, id: workflowId } = req.params as { wid: string; id: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const workflow = await store.get(wid, workflowId);
    if (!workflow) return reply.code(404).send({ error: "workflow not found" });
    return (await store.listRuns(wid)).filter((r) => r.workflowId === workflowId);
  });

  /** The workspace's run-history insights (the console success/failure trend). */
  app.get("/workspaces/:wid/workflows-insights", async (req, reply: FastifyReply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const runs = await store.listRuns(wid, 500);
    return aggregateWorkflowInsights(runs, new Date());
  });

  /**
   * Public webhook trigger. Authenticated by the token hash (no workspace guard) — resolves the
   * workflow's own workspace. Default-OFF + the workflow's `enabled` flag still gate execution.
   */
  app.post("/workflows/hooks/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const workflow = await store.findByWebhookHash(hashWebhookToken(token));
    if (!workflow || workflow.triggerKind !== "webhook") {
      return reply.code(404).send({ error: "unknown webhook" });
    }
    const run = await engine.runWorkflow(workflow, "webhook");
    return reply.code(202).send({ id: run.id, status: run.status, reason: run.reason });
  });
}
