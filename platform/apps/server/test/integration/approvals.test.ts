import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

let app: FastifyInstance;
const slugs: string[] = [];

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await closeDb();
});

interface Owner {
  cookie: string;
  workspaceId: string;
  memberId: string;
}

async function newOwner(): Promise<Owner> {
  const slug = `appr-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

async function newAgent(owner: Owner, name: string): Promise<{ memberId: string; token: string }> {
  const reg = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/agents`,
      cookies: { rid: owner.cookie },
      payload: { name },
    })
  ).json();
  return { memberId: reg.memberId, token: reg.token };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Make the agent a writer in a fresh channel and return the channel id. */
async function channelWithAgent(owner: Owner, agentMemberId: string): Promise<string> {
  const channel = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/channels`,
      cookies: { rid: owner.cookie },
      payload: { name: `c-${newId()}` },
    })
  ).json();
  await app.inject({
    method: "POST",
    url: `/channels/${channel.id}/grants`,
    cookies: { rid: owner.cookie },
    payload: { memberId: agentMemberId, capability: "write" },
  });
  return channel.id;
}

describe("Approval gates: submit → pause → approve/reject/expire + audit (real Postgres)", () => {
  it("gated chat action pauses, then approval executes it (message appears) and audits the chain", async () => {
    const owner = await newOwner();
    const agent = await newAgent(owner, "Poster");
    const channelId = await channelWithAgent(owner, agent.memberId);

    // gate chat.post_message in this workspace
    const policy = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/approval-policies`,
      cookies: { rid: owner.cookie },
      payload: { actionType: "chat.post_message", requireApproval: true },
    });
    expect(policy.statusCode).toBe(201);

    // the agent submits the gated action — it must NOT post yet
    const submit = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      headers: bearer(agent.token),
      payload: { actionType: "chat.post_message", payload: { channelId, body: "deploy shipped 🚀" } },
    });
    expect(submit.statusCode).toBe(202);
    expect(submit.json().status).toBe("pending");
    const requestId = submit.json().request.id;

    // nothing posted to the channel yet
    const before = (
      await app.inject({ method: "GET", url: `/channels/${channelId}/messages`, cookies: { rid: owner.cookie } })
    ).json();
    expect(before).toHaveLength(0);

    // a human approves → executes → message now exists
    const approve = await app.inject({
      method: "POST",
      url: `/approvals/${requestId}/approve`,
      cookies: { rid: owner.cookie },
      payload: { reason: "looks good" },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("executed");

    const after = (
      await app.inject({ method: "GET", url: `/channels/${channelId}/messages`, cookies: { rid: owner.cookie } })
    ).json();
    expect(after).toHaveLength(1);
    expect(after[0].body).toBe("deploy shipped 🚀");
    expect(after[0].authorMemberId).toBe(agent.memberId); // executed as the requester

    // audit: requested → approved → executed
    const events = (
      await app.inject({ method: "GET", url: `/approvals/${requestId}/events`, cookies: { rid: owner.cookie } })
    ).json();
    expect(events.map((e: { type: string }) => e.type)).toEqual(["requested", "approved", "executed"]);

    // re-approving a decided request is a 409
    const again = await app.inject({
      method: "POST",
      url: `/approvals/${requestId}/approve`,
      cookies: { rid: owner.cookie },
    });
    expect(again.statusCode).toBe(409);
  });

  it("reject blocks the action (no message, terminal rejected, audited)", async () => {
    const owner = await newOwner();
    const agent = await newAgent(owner, "Poster");
    const channelId = await channelWithAgent(owner, agent.memberId);
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/approval-policies`,
      cookies: { rid: owner.cookie },
      payload: { actionType: "chat.post_message", requireApproval: true },
    });

    const requestId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${owner.workspaceId}/actions`,
        headers: bearer(agent.token),
        payload: { actionType: "chat.post_message", payload: { channelId, body: "nope" } },
      })
    ).json().request.id;

    const reject = await app.inject({
      method: "POST",
      url: `/approvals/${requestId}/reject`,
      cookies: { rid: owner.cookie },
      payload: { reason: "not now" },
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().status).toBe("rejected");

    const msgs = (
      await app.inject({ method: "GET", url: `/channels/${channelId}/messages`, cookies: { rid: owner.cookie } })
    ).json();
    expect(msgs).toHaveLength(0); // blocked: never executed

    const fresh = (
      await app.inject({ method: "GET", url: `/approvals/${requestId}`, cookies: { rid: owner.cookie } })
    ).json();
    expect(fresh.status).toBe("rejected");
    expect(fresh.reason).toBe("not now");
  });

  it("an expired request cannot be approved (ttlSeconds:0 → 409 expired)", async () => {
    const owner = await newOwner();
    const agent = await newAgent(owner, "Poster");
    const channelId = await channelWithAgent(owner, agent.memberId);
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/approval-policies`,
      cookies: { rid: owner.cookie },
      payload: { actionType: "chat.post_message", requireApproval: true },
    });

    const requestId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${owner.workspaceId}/actions`,
        headers: bearer(agent.token),
        payload: { actionType: "chat.post_message", payload: { channelId, body: "late" }, ttlSeconds: 0 },
      })
    ).json().request.id;

    const approve = await app.inject({
      method: "POST",
      url: `/approvals/${requestId}/approve`,
      cookies: { rid: owner.cookie },
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().status).toBe("expired");

    // and the audit records the expiry; the channel stayed empty
    const events = (
      await app.inject({ method: "GET", url: `/approvals/${requestId}/events`, cookies: { rid: owner.cookie } })
    ).json();
    expect(events.map((e: { type: string }) => e.type)).toEqual(["requested", "expired"]);
    expect(
      (await app.inject({ method: "GET", url: `/channels/${channelId}/messages`, cookies: { rid: owner.cookie } })).json(),
    ).toHaveLength(0);
  });

  it("external.send is gated by default; an agent cannot decide its own request (humans only)", async () => {
    const owner = await newOwner();
    const agent = await newAgent(owner, "Sender");

    // no rule for external.send → sensitive by default → pending
    const submit = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      headers: bearer(agent.token),
      payload: { actionType: "external.send", payload: { summary: "page oncall", target: "ops" } },
    });
    expect(submit.statusCode).toBe(202);
    const requestId = submit.json().request.id;

    // the agent (Bearer) cannot approve — humans only
    const agentApprove = await app.inject({
      method: "POST",
      url: `/approvals/${requestId}/approve`,
      headers: bearer(agent.token),
    });
    expect(agentApprove.statusCode).toBe(403);

    // a human approves → external.send is recorded (no real egress)
    const approve = await app.inject({
      method: "POST",
      url: `/approvals/${requestId}/approve`,
      cookies: { rid: owner.cookie },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().result).toMatchObject({ recorded: true, target: "ops" });
  });

  it("a non-sensitive action with no rule auto-executes (no approval row pending)", async () => {
    const owner = await newOwner();
    const agent = await newAgent(owner, "Poster");
    const channelId = await channelWithAgent(owner, agent.memberId);

    // chat.post_message is NOT sensitive by default and no rule gates it → executes immediately
    const submit = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      headers: bearer(agent.token),
      payload: { actionType: "chat.post_message", payload: { channelId, body: "fyi" } },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().status).toBe("executed");

    expect(
      (await app.inject({ method: "GET", url: `/channels/${channelId}/messages`, cookies: { rid: owner.cookie } })).json(),
    ).toHaveLength(1);

    // no pending requests in the queue
    const pending = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${owner.workspaceId}/approvals?status=pending`,
        cookies: { rid: owner.cookie },
      })
    ).json();
    expect(pending).toHaveLength(0);
  });

  it("rejects cross-workspace request access and decision (IDOR)", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const agent = await newAgent(a, "Sender");

    const requestId = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${a.workspaceId}/actions`,
        headers: bearer(agent.token),
        payload: { actionType: "external.send", payload: { summary: "secret" } },
      })
    ).json().request.id;

    // B cannot read A's request
    expect(
      (await app.inject({ method: "GET", url: `/approvals/${requestId}`, cookies: { rid: b.cookie } })).statusCode,
    ).toBe(404);
    // B cannot approve A's request
    expect(
      (await app.inject({ method: "POST", url: `/approvals/${requestId}/approve`, cookies: { rid: b.cookie } })).statusCode,
    ).toBe(404);
    // B cannot submit under A's workspace path
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/workspaces/${a.workspaceId}/actions`,
          cookies: { rid: b.cookie },
          payload: { actionType: "external.send", payload: { summary: "x" } },
        })
      ).statusCode,
    ).toBe(403);
  });
});
