import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { signSlackRequest } from "../../src/slack/verify.js";
import type { SlackClient, SlackPostMessageInput } from "../../src/slack/client.js";

/**
 * #170 Slack-native ipop — end-to-end over real Postgres + a recording Slack client (no real Slack
 * call). Proves: the masked connect vault (token never echoed), webhook 503-until-connected +
 * signature verification, an `app_mention` flowing into the EXISTING post path (a message lands in the
 * linked channel), and the Approve button round-tripping through the SAME #13 decision path with the
 * member's identity + audit — including the humans-only / can't-approve-your-own guards.
 */

/** Records every outbound Slack call so we can assert on it without a network. */
class RecordingClient implements SlackClient {
  posts: Array<{ token: string; input: SlackPostMessageInput }> = [];
  dms: string[] = [];
  async postMessage(token: string, input: SlackPostMessageInput): Promise<{ ts: string } | null> {
    this.posts.push({ token, input });
    return { ts: `ts-${this.posts.length}` };
  }
  async openDm(_token: string, userId: string): Promise<{ channel: string } | null> {
    this.dms.push(userId);
    return { channel: `D-${userId}` };
  }
}

let app: FastifyInstance;
let slackClient: RecordingClient;
const slugs: string[] = [];

const SIGNING_SECRET = "slack_signing_secret_integration";
const BOT_TOKEN = "xoxb-integration-secret-token";

beforeAll(async () => {
  slackClient = new RecordingClient();
  app = buildApp({ slackClient });
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await closeDb();
  await closeRedis();
});

interface Owner {
  cookie: string;
  workspaceId: string;
  memberId: string;
}

async function newOwner(): Promise<Owner> {
  const slug = `slack-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pwpwpwpw", displayName: "Owner", workspaceSlug: slug },
  });
  expect(signup.statusCode).toBe(201);
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

/** Connect Slack for a workspace and link the owner's Slack user id. */
async function connectSlack(owner: Owner, slackUserId = "U-OWNER"): Promise<void> {
  const res = await app.inject({
    method: "PUT",
    url: "/me/slack",
    cookies: { rid: owner.cookie },
    payload: { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET, teamId: "T1", botUserId: "U0BOT", slackUserId },
  });
  expect(res.statusCode).toBe(200);
}

/** POST a signed Slack webhook with the exact raw body we signed. */
function signedInject(url: string, rawBody: string, contentType: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = signSlackRequest(rawBody, SIGNING_SECRET, Number(ts));
  return app.inject({
    method: "POST",
    url,
    payload: rawBody,
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    },
  });
}

describe("Connect Slack API (#170 — masked write-only vault)", () => {
  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/me/slack" });
    expect(res.statusCode).toBe(401);
  });

  it("connects, reports connected, and NEVER echoes the secrets", async () => {
    const owner = await newOwner();
    const put = await app.inject({
      method: "PUT",
      url: "/me/slack",
      cookies: { rid: owner.cookie },
      payload: { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET, teamId: "T1" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(BOT_TOKEN);
    expect(put.body).not.toContain(SIGNING_SECRET);
    expect(put.json()).toMatchObject({ connected: true, teamId: "T1" });
    expect(put.json().fingerprint).toBeTruthy();

    const get = await app.inject({ method: "GET", url: "/me/slack", cookies: { rid: owner.cookie } });
    expect(get.json()).toMatchObject({ connected: true });
    expect(get.body).not.toContain(BOT_TOKEN);
    expect(get.body).not.toContain(SIGNING_SECRET);
  });

  it("rejects a connect missing the bot token or signing secret", async () => {
    const owner = await newOwner();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/me/slack",
          cookies: { rid: owner.cookie },
          payload: { signingSecret: SIGNING_SECRET },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("disconnects (idempotent)", async () => {
    const owner = await newOwner();
    await connectSlack(owner);
    const del = await app.inject({ method: "DELETE", url: "/me/slack", cookies: { rid: owner.cookie } });
    expect(del.json()).toMatchObject({ connected: false });
    const get = await app.inject({ method: "GET", url: "/me/slack", cookies: { rid: owner.cookie } });
    expect(get.json()).toMatchObject({ connected: false });
  });
});

describe("Slack webhooks (#170 — 503-until-connected + signature)", () => {
  it("503s the events webhook until the workspace is connected", async () => {
    const owner = await newOwner();
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const res = await signedInject(`/slack/events/${owner.workspaceId}`, body, "application/json");
    expect(res.statusCode).toBe(503);
  });

  it("rejects a forged signature once connected", async () => {
    const owner = await newOwner();
    await connectSlack(owner);
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const res = await app.inject({
      method: "POST",
      url: `/slack/events/${owner.workspaceId}`,
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=deadbeef",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("echoes the url_verification challenge for a valid signature", async () => {
    const owner = await newOwner();
    await connectSlack(owner);
    const body = JSON.stringify({ type: "url_verification", challenge: "challenge-123" });
    const res = await signedInject(`/slack/events/${owner.workspaceId}`, body, "application/json");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ challenge: "challenge-123" });
  });
});

describe("Slack app_mention → existing post path (#170)", () => {
  it("posts the translated mention into the linked channel as the acting member", async () => {
    const owner = await newOwner();
    await connectSlack(owner, "U-AUTHOR");
    // A platform channel linked to a Slack channel; the owner's Slack user is linked above.
    const channel = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${owner.workspaceId}/channels`,
        cookies: { rid: owner.cookie },
        payload: { name: `c-${newId()}` },
      })
    ).json();
    const link = await app.inject({
      method: "PUT",
      url: "/me/slack/channel-link",
      cookies: { rid: owner.cookie },
      payload: { slackChannelId: "C-SLACK", channelId: channel.id },
    });
    expect(link.statusCode).toBe(200);

    const body = JSON.stringify({
      type: "event_callback",
      event_id: `Ev-${newId()}`,
      event: { type: "app_mention", channel: "C-SLACK", user: "U-AUTHOR", text: "<@U0BOT> ship the audit", ts: "100.1" },
    });
    const res = await signedInject(`/slack/events/${owner.workspaceId}`, body, "application/json");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: "launched" });

    const messages = (
      await app.inject({ method: "GET", url: `/channels/${channel.id}/messages`, cookies: { rid: owner.cookie } })
    ).json();
    expect(messages.some((m: { body: string }) => m.body === "@ship the audit")).toBe(true);
  });

  it("dedupes a retried event id (no duplicate message)", async () => {
    const owner = await newOwner();
    await connectSlack(owner, "U-AUTHOR");
    const channel = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${owner.workspaceId}/channels`,
        cookies: { rid: owner.cookie },
        payload: { name: `c-${newId()}` },
      })
    ).json();
    await app.inject({
      method: "PUT",
      url: "/me/slack/channel-link",
      cookies: { rid: owner.cookie },
      payload: { slackChannelId: "C-DUP", channelId: channel.id },
    });
    const eventId = `Ev-${newId()}`;
    const body = JSON.stringify({
      type: "event_callback",
      event_id: eventId,
      event: { type: "app_mention", channel: "C-DUP", user: "U-AUTHOR", text: "<@U0BOT> once", ts: "1.1" },
    });
    await signedInject(`/slack/events/${owner.workspaceId}`, body, "application/json");
    const second = await signedInject(`/slack/events/${owner.workspaceId}`, body, "application/json");
    expect(second.json()).toMatchObject({ status: "duplicate" });
    const messages = (
      await app.inject({ method: "GET", url: `/channels/${channel.id}/messages`, cookies: { rid: owner.cookie } })
    ).json();
    expect(messages.filter((m: { body: string }) => m.body === "@once").length).toBe(1);
  });
});

describe("Slack interactivity → #13 decision round-trip (#170)", () => {
  it("approves a pending action AS the owner (different from the agent requester) + audits it", async () => {
    const owner = await newOwner();
    await connectSlack(owner, "U-OWNER");
    const agent = await newAgent(owner, `agent-${newId()}`);

    // The agent submits a money action (billing.refund) → gated by default (#243) → pending (requester = agent).
    const submit = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      headers: { authorization: `Bearer ${agent.token}` },
      payload: { actionType: "billing.refund", payload: { paymentIntentId: "pi_slack", reason: "double charge" } },
    });
    expect(submit.statusCode).toBe(202);
    const rid = submit.json().request.id;

    // The owner clicks Approve in Slack (decider = owner human ≠ agent requester).
    const payload = JSON.stringify({
      user: { id: "U-OWNER" },
      actions: [{ action_id: "ipop_approve", value: JSON.stringify({ rid, wid: owner.workspaceId }) }],
    });
    const raw = `payload=${encodeURIComponent(payload)}`;
    const res = await signedInject(`/slack/interact/${owner.workspaceId}`, raw, "application/x-www-form-urlencoded");
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toMatch(/Approved/);

    // The #13 audit trail reflects the Slack-driven decision, attributed to the owner.
    const request = (
      await app.inject({ method: "GET", url: `/approvals/${rid}`, cookies: { rid: owner.cookie } })
    ).json();
    expect(request.status).toBe("executed");
    expect(request.decidedByMemberId).toBe(owner.memberId);
    const events = (
      await app.inject({ method: "GET", url: `/approvals/${rid}/events`, cookies: { rid: owner.cookie } })
    ).json();
    expect(events.map((e: { type: string }) => e.type)).toEqual(["requested", "approved", "executed"]);
  });

  it("refuses to let the owner approve their OWN request via Slack (gate intact)", async () => {
    const owner = await newOwner();
    await connectSlack(owner, "U-OWNER");
    // The owner submits the action themselves (requester = owner).
    const submit = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      cookies: { rid: owner.cookie },
      payload: { actionType: "billing.refund", payload: { paymentIntentId: "pi_self", reason: "self-approve attempt" } },
    });
    expect(submit.statusCode).toBe(202);
    const rid = submit.json().request.id;

    const payload = JSON.stringify({
      user: { id: "U-OWNER" },
      actions: [{ action_id: "ipop_approve", value: JSON.stringify({ rid, wid: owner.workspaceId }) }],
    });
    const raw = `payload=${encodeURIComponent(payload)}`;
    const res = await signedInject(`/slack/interact/${owner.workspaceId}`, raw, "application/x-www-form-urlencoded");
    expect(res.statusCode).toBe(200);

    // Still pending — the own-request guard held; nothing executed.
    const request = (
      await app.inject({ method: "GET", url: `/approvals/${rid}`, cookies: { rid: owner.cookie } })
    ).json();
    expect(request.status).toBe("pending");
  });

  it("DMs the owner Approve/Reject buttons when an action goes pending", async () => {
    const owner = await newOwner();
    await connectSlack(owner, "U-OWNER");
    const agent = await newAgent(owner, `agent-${newId()}`);
    const before = slackClient.posts.length;
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      headers: { authorization: `Bearer ${agent.token}` },
      payload: { actionType: "billing.refund", payload: { paymentIntentId: "pi_dm", reason: "needs a human" } },
    });
    // The pending hook DMed the owner a Block Kit message with the two buttons (best-effort, recorded).
    const dm = slackClient.posts.slice(before).find((p) =>
      JSON.stringify(p.input.blocks ?? []).includes("ipop_approve"),
    );
    expect(dm).toBeTruthy();
    expect(slackClient.dms).toContain("U-OWNER");
  });
});
