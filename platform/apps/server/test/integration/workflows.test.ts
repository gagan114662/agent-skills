import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { workflowStore } from "../../src/db/repositories/workflows.js";
import { listCatalogEntries } from "../../src/db/repositories/catalog.js";
import { buildCatalogFacts } from "../../src/workflows/facts.js";
import { createRequest, listRequests } from "../../src/db/repositories/approvals.js";
import { buildMarketingSend, isMarketingSendKind } from "../../src/marketing/external-send.js";

/**
 * Visual workflow builder (#152) over real Postgres. The injected {@link WorkflowEngine} uses the REAL
 * store + the REAL #13 draft-send gate (a draft_send becomes a pending `external.send` approval) + a
 * FAKE launcher (a uuid, no model spend) + a stubbed agent-member resolver. Caps are driven by mutable
 * module vars so one app exercises the default-OFF gate + the conditions gate + the rate cap.
 */

const launches: Array<{ workspaceId: string; channelId: string; task: string }> = [];
let capsEnabled = true;
let maxRunsPerWindow = 50;
const flywheelEvents: Array<{ failureClass: string }> = [];

function makeEngine(): WorkflowEngine {
  return new WorkflowEngine({
    store: workflowStore,
    launcher: {
      launch: async (input) => {
        launches.push({ workspaceId: input.workspaceId, channelId: input.channelId, task: input.task });
        return { id: newId() };
      },
    },
    draftSendGate: {
      submit: async (input) => {
        if (!isMarketingSendKind(input.sendKind)) throw new Error("bad kind");
        const descriptor = buildMarketingSend({
          kind: input.sendKind,
          summary: input.summary,
          target: input.target,
          amountCents: input.amountCents,
        });
        const req = await createRequest({
          workspaceId: input.workspaceId,
          requesterMemberId: input.requesterMemberId,
          actionType: descriptor.actionType,
          payload: descriptor.payload,
          amount: descriptor.amount,
          summary: input.summary,
          status: "pending",
          expiresAt: null,
          events: [{ type: "requested", detail: { source: "workflow" } }],
        });
        return { approvalRequestId: req.id };
      },
    },
    notifier: { notifyOwner: async () => ({ id: newId() }) },
    resolveAgentMember: async () => ({ agentMemberId: newId() }),
    resolveFacts: async (workflow) => buildCatalogFacts(await listCatalogEntries(workflow.workspaceId)),
    caps: () => ({ enabled: capsEnabled, maxRunsPerWindow, windowMinutes: 1440, maxPerWorkspace: 50, maxActionsPerRun: 10 }),
    killSwitch: async () => false,
    flywheelRecord: async (e) => {
      flywheelEvents.push({ failureClass: e.failureClass });
      return undefined;
    },
    logger: { info() {}, warn() {}, error() {}, child() { return this; } } as never,
  });
}

const app: FastifyInstance = buildApp({ workflows: makeEngine() });
const slugs: string[] = [];

beforeAll(() => {
  process.env.RELOAD_CATALOG_ENABLED = "true";
});

afterAll(async () => {
  delete process.env.RELOAD_CATALOG_ENABLED;
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface World {
  workspaceId: string;
  cookie: string;
  channelId: string;
}

async function seed(): Promise<World> {
  const slug = `wf-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  const channel = await app.inject({
    method: "POST",
    url: `/workspaces/${me.workspaceId}/channels`,
    cookies: { rid: cookie },
    payload: { name: "seo" },
  });
  return { workspaceId: me.workspaceId, cookie, channelId: channel.json().id };
}

const post = (w: World, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url: `/workspaces/${w.workspaceId}${url}`, cookies: { rid: w.cookie }, payload });
const get = (w: World, url: string) =>
  app.inject({ method: "GET", url: `/workspaces/${w.workspaceId}${url}`, cookies: { rid: w.cookie } });

describe("workflows (real Postgres): trigger → condition → action chains", () => {
  it(
    "creates + lists workflows, fires actions through gated paths, gates on conditions + the rate cap + " +
      "default-OFF, drafts a #13 approval (no egress), and isolates tenants",
    async () => {
      capsEnabled = true;
      maxRunsPerWindow = 50;
      launches.length = 0;
      flywheelEvents.length = 0;
      const w = await seed();
      const other = await seed();

      // (1) seed a catalog the conditions read.
      await post(w, "/catalog", { kind: "site", name: "ipop.ai", identifier: "https://ipop.ai" });

      // (2) create a schedule workflow: when there is >=1 active site, an agent drafts + a draft_send
      //     is queued for approval + the owner is notified.
      const created = await post(w, "/workflows", {
        name: "Site-live launch kit",
        trigger: { kind: "schedule", schedule: { cadence: "daily", hour: 9, minute: 0 } },
        conditions: [{ fact: "catalog.site.active", op: "gte", value: 1 }],
        actions: [
          { kind: "agent_task", channelId: w.channelId, agentHandle: "scout", task: "Draft a launch post." },
          { kind: "draft_send", sendKind: "social.post", summary: "Launch tweet for ipop.ai" },
          { kind: "notify_owner", message: "Launch kit prepared." },
        ],
        enabled: true,
      });
      expect(created.statusCode).toBe(201);
      const workflowId = created.json().id;
      expect(created.json().nextRunAt).toBeTruthy();

      // listed for w, not for the sibling tenant.
      expect((await get(w, "/workflows")).json()).toHaveLength(1);
      expect((await get(other, "/workflows")).json()).toHaveLength(0);

      // (3) run now: conditions hold (one active site) → all three actions fire.
      const run = await post(w, `/workflows/${workflowId}/run`);
      expect(run.statusCode).toBe(202);
      expect(run.json().status).toBe("fired");
      expect(run.json().results.map((r: { kind: string; status: string }) => `${r.kind}:${r.status}`)).toEqual([
        "agent_task:ok",
        "draft_send:ok",
        "notify_owner:ok",
      ]);
      expect(launches).toHaveLength(1);
      expect(launches[0].task).toContain("launch post");

      // the draft_send created a PENDING #13 approval — nothing left the building.
      const pending = await listRequests(w.workspaceId, { status: "pending" });
      expect(pending.some((r) => r.actionType === "external.send")).toBe(true);

      // (4) the run shows up in the ledger + insights.
      const runs = (await get(w, `/workflows/${workflowId}/runs`)).json();
      expect(runs).toHaveLength(1);
      const insights = (await get(w, "/workflows-insights")).json();
      expect(insights.byStatus.fired).toBe(1);
      expect(insights.successRate).toBe(1);

      // (5) conditions gate: a workflow needing >=5 active sites skips with a condition reason.
      const gated = await post(w, "/workflows", {
        name: "Needs five sites",
        trigger: { kind: "webhook" },
        conditions: [{ fact: "catalog.site.active", op: "gte", value: 5 }],
        actions: [{ kind: "notify_owner", message: "nope" }],
        enabled: true,
      });
      const gatedRun = await post(w, `/workflows/${gated.json().id}/run`);
      expect(gatedRun.json().status).toBe("skipped");
      expect(gatedRun.json().reason).toContain("conditions_unmet");

      // (6) rate cap: drop the window to 1 firing; the next run is rate_limited (no new launch).
      maxRunsPerWindow = 1;
      launches.length = 0;
      const capped = await post(w, `/workflows/${workflowId}/run`);
      expect(capped.json().status).toBe("skipped");
      expect(capped.json().reason).toBe("rate_limited");
      expect(launches).toHaveLength(0);
      maxRunsPerWindow = 50;

      // (7) default-OFF: caps disabled ⇒ even a manual run is a no-op skip.
      capsEnabled = false;
      const off = await post(w, `/workflows/${workflowId}/run`);
      expect(off.json().status).toBe("skipped");
      expect(off.json().reason).toBe("workflows_disabled");
      capsEnabled = true;

      // no failures were recorded, so the flywheel was never fed.
      expect(flywheelEvents).toHaveLength(0);
    },
  );

  it("a webhook workflow returns its token once and fires through the public hook route", async () => {
    capsEnabled = true;
    maxRunsPerWindow = 50;
    launches.length = 0;
    const w = await seed();
    const created = await post(w, "/workflows", {
      name: "Inbound webhook",
      trigger: { kind: "webhook" },
      actions: [{ kind: "agent_task", channelId: w.channelId, agentHandle: "scout", task: "Handle the webhook." }],
      enabled: true,
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().webhookToken;
    expect(token).toMatch(/^whk_/);

    const fired = await app.inject({ method: "POST", url: `/workflows/hooks/${token}` });
    expect(fired.statusCode).toBe(202);
    expect(fired.json().status).toBe("fired");
    expect(launches).toHaveLength(1);

    // an unknown token is a 404 (and the token is never returned again on list).
    expect((await app.inject({ method: "POST", url: `/workflows/hooks/whk_bogus` })).statusCode).toBe(404);
    expect((await get(w, "/workflows")).json()[0].webhookToken).toBeUndefined();
  });

  it("a catalog_change workflow fires when a matching catalog entry is created", async () => {
    capsEnabled = true;
    maxRunsPerWindow = 50;
    launches.length = 0;
    const w = await seed();
    const created = await post(w, "/workflows", {
      name: "On new venture",
      trigger: { kind: "catalog_change", catalogKind: "venture" },
      actions: [{ kind: "notify_owner", message: "A new venture was cataloged." }],
      enabled: true,
    });
    expect(created.statusCode).toBe(201);

    // creating a venture entry fires the catalog_change workflow (best-effort, awaited via the run ledger).
    await post(w, "/catalog", { kind: "venture", name: "NewCo" });
    // give the fire-and-forget a tick to land its run.
    await new Promise((r) => setTimeout(r, 50));
    const runs = (await get(w, `/workflows/${created.json().id}/runs`)).json();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("fired");

    // a non-matching catalog kind (site) does NOT fire it.
    const before = runs.length;
    await post(w, "/catalog", { kind: "site", name: "other.com" });
    await new Promise((r) => setTimeout(r, 50));
    const after = (await get(w, `/workflows/${created.json().id}/runs`)).json();
    expect(after.length).toBe(before);
  });
});
