import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { approvalRequests, workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

let app: FastifyInstance;
const slugs: string[] = [];

beforeAll(async () => {
  app = buildApp();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface Human {
  cookie: string;
  workspaceId: string;
  memberId: string;
}

async function newHuman(name = "Lead"): Promise<Human> {
  const slug = `ap-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: name, workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

async function registerAgent(h: Human, name: string): Promise<{ token: string; memberId: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${h.workspaceId}/agents`,
    cookies: { rid: h.cookie },
    payload: { name },
  });
  return { token: res.json().token as string, memberId: res.json().memberId as string };
}

async function createChannel(h: Human, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${h.workspaceId}/channels`,
    cookies: { rid: h.cookie },
    payload: { name },
  });
  return res.json().id as string;
}

async function channelMessageCount(h: Human, cid: string): Promise<number> {
  const res = await app.inject({ method: "GET", url: `/channels/${cid}/messages`, cookies: { rid: h.cookie } });
  return (res.json() as unknown[]).length;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("approval gates & governance (real Postgres + Redis, #13)", () => {
  it("a sensitive agent action pends (not executed); a human approval executes it", async () => {
    const h = await newHuman("Lead");
    const agent = await registerAgent(h, "Scout");
    const cid = await createChannel(h, "ops");

    // an external_send is gated by the default policy → pending, executor NOT run
    const requested = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/approvals`,
      headers: bearer(agent.token),
      payload: { actionKind: "external_send", summary: "email the quarterly report", channelId: cid, destination: "cfo@acme.com" },
    });
    expect(requested.statusCode).toBe(201);
    const req = requested.json();
    expect(req.status).toBe("pending");
    expect(req.expiresAt).not.toBeNull();
    expect(req.executedAt).toBeNull();
    expect(await channelMessageCount(h, cid)).toBe(0); // nothing executed yet

    // a human approves → the action executes exactly once (a channel message appears)
    const approved = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/approvals/${req.id}/approve`,
      cookies: { rid: h.cookie },
      payload: { reason: "approved by lead" },
    });
    expect(approved.statusCode).toBe(200);
    const decided = approved.json();
    expect(decided.status).toBe("approved");
    expect(decided.decidedByMemberId).toBe(h.memberId);
    expect(decided.decisionReason).toBe("approved by lead");
    expect(decided.executedAt).not.toBeNull();
    expect(decided.outcome).toMatch(/posted message/);
    expect(await channelMessageCount(h, cid)).toBe(1);
  });

  it("a rejected request blocks the action — nothing executes — and records the reason", async () => {
    const h = await newHuman("Boss");
    const agent = await registerAgent(h, "Worker");
    const cid = await createChannel(h, "wire");

    const req = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${h.workspaceId}/approvals`,
        headers: bearer(agent.token),
        payload: { actionKind: "external_send", summary: "post to twitter", channelId: cid },
      })
    ).json();

    const rejected = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/approvals/${req.id}/reject`,
      cookies: { rid: h.cookie },
      payload: { reason: "off-brand" },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe("rejected");
    expect(rejected.json().decisionReason).toBe("off-brand");
    expect(await channelMessageCount(h, cid)).toBe(0); // blocked: never executed

    // rejecting requires a reason
    const req2 = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${h.workspaceId}/approvals`,
        headers: bearer(agent.token),
        payload: { actionKind: "external_send", summary: "another send" },
      })
    ).json();
    const noReason = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/approvals/${req2.id}/reject`,
      cookies: { rid: h.cookie },
      payload: {},
    });
    expect(noReason.statusCode).toBe(400);
  });

  it("an action the policy does not gate is auto-approved and executed immediately", async () => {
    const h = await newHuman("PM");
    const agent = await registerAgent(h, "Helper");
    const cid = await createChannel(h, "auto");

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/approvals`,
      headers: bearer(agent.token),
      payload: { actionKind: "custom", summary: "rename a label", channelId: cid },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("auto_approved");
    expect(res.json().executedAt).not.toBeNull();
    expect(await channelMessageCount(h, cid)).toBe(1);
  });

  it("a pending request past its TTL expires and can no longer be approved", async () => {
    const h = await newHuman("Owner");
    const agent = await registerAgent(h, "Slow");

    const req = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${h.workspaceId}/approvals`,
        headers: bearer(agent.token),
        payload: { actionKind: "external_send", summary: "expiring send" },
      })
    ).json();

    // force the TTL into the past (a background sweeper would do this on a schedule)
    await db
      .update(approvalRequests)
      .set({ expiresAt: sql`now() - interval '1 hour'` })
      .where(eq(approvalRequests.id, req.id));

    const late = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/approvals/${req.id}/approve`,
      cookies: { rid: h.cookie },
    });
    expect(late.statusCode).toBe(409);
    const after = await app.inject({
      method: "GET",
      url: `/workspaces/${h.workspaceId}/approvals/${req.id}`,
      cookies: { rid: h.cookie },
    });
    expect(after.json().status).toBe("expired");
  });

  it("only a human may approve; an agent attempting to approve is forbidden", async () => {
    const h = await newHuman("Chief");
    const agent = await registerAgent(h, "Eager");

    const req = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${h.workspaceId}/approvals`,
        headers: bearer(agent.token),
        payload: { actionKind: "external_send", summary: "agent self-approve attempt" },
      })
    ).json();

    const byAgent = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/approvals/${req.id}/approve`,
      headers: bearer(agent.token),
    });
    expect(byAgent.statusCode).toBe(403);
    // still pending — the bypass attempt changed nothing
    const still = await app.inject({
      method: "GET",
      url: `/workspaces/${h.workspaceId}/approvals/${req.id}`,
      headers: bearer(agent.token),
    });
    expect(still.json().status).toBe("pending");
  });

  it("a terminal request cannot be re-decided (audit integrity)", async () => {
    const h = await newHuman("Auditor");
    const agent = await registerAgent(h, "Once");
    const req = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${h.workspaceId}/approvals`,
        headers: bearer(agent.token),
        payload: { actionKind: "external_send", summary: "decide once" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/approvals/${req.id}/approve`,
      cookies: { rid: h.cookie },
    });
    const again = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/approvals/${req.id}/reject`,
      cookies: { rid: h.cookie },
      payload: { reason: "changed mind" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("requests are workspace-scoped: another workspace cannot see or decide them (IDOR)", async () => {
    const h = await newHuman("WsOne");
    const agent = await registerAgent(h, "Mine");
    const req = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${h.workspaceId}/approvals`,
        headers: bearer(agent.token),
        payload: { actionKind: "external_send", summary: "private to ws one" },
      })
    ).json();

    const other = await newHuman("WsTwo");
    // cross-workspace path is a 403 (wrong workspace guard) before the id is ever resolved
    const peek = await app.inject({
      method: "GET",
      url: `/workspaces/${other.workspaceId}/approvals/${req.id}`,
      cookies: { rid: other.cookie },
    });
    expect(peek.statusCode).toBe(404);
    // and even addressed through the victim's own workspace, the outsider is rejected (not a member)
    const cross = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/approvals/${req.id}/approve`,
      cookies: { rid: other.cookie },
    });
    expect(cross.statusCode).toBe(403);
  });

  it("the audit list is queryable and filters by status", async () => {
    const h = await newHuman("Keeper");
    const agent = await registerAgent(h, "Logger");

    // one gated (pending) + one ungated (auto_approved)
    await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/approvals`,
      headers: bearer(agent.token),
      payload: { actionKind: "external_send", summary: "pending one" },
    });
    await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/approvals`,
      headers: bearer(agent.token),
      payload: { actionKind: "custom", summary: "auto one" },
    });

    const all = await app.inject({
      method: "GET",
      url: `/workspaces/${h.workspaceId}/approvals`,
      cookies: { rid: h.cookie },
    });
    expect(all.json().length).toBe(2);

    const pendingOnly = await app.inject({
      method: "GET",
      url: `/workspaces/${h.workspaceId}/approvals?status=pending`,
      cookies: { rid: h.cookie },
    });
    expect(pendingOnly.json().length).toBe(1);
    expect(pendingOnly.json()[0].status).toBe("pending");
  });

  it("governance policy reads defaults and a human can change it (agents cannot)", async () => {
    const h = await newHuman("Gov");
    const agent = await registerAgent(h, "Reader");

    const defaults = await app.inject({
      method: "GET",
      url: `/workspaces/${h.workspaceId}/governance-policy`,
      headers: bearer(agent.token),
    });
    expect(defaults.json()).toMatchObject({ externalSendRequiresApproval: true, spendThresholdCents: 0 });

    // an agent cannot write the policy
    const byAgent = await app.inject({
      method: "PUT",
      url: `/workspaces/${h.workspaceId}/governance-policy`,
      headers: bearer(agent.token),
      payload: { externalSendRequiresApproval: false },
    });
    expect(byAgent.statusCode).toBe(403);

    // a human turns off external-send gating + raises the spend threshold
    const updated = await app.inject({
      method: "PUT",
      url: `/workspaces/${h.workspaceId}/governance-policy`,
      cookies: { rid: h.cookie },
      payload: { externalSendRequiresApproval: false, spendThresholdCents: 10000 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ externalSendRequiresApproval: false, spendThresholdCents: 10000 });

    // now an external_send auto-approves under the relaxed policy
    const send = await app.inject({
      method: "POST",
      url: `/workspaces/${h.workspaceId}/approvals`,
      headers: bearer(agent.token),
      payload: { actionKind: "external_send", summary: "now allowed" },
    });
    expect(send.json().status).toBe("auto_approved");
  });
});
