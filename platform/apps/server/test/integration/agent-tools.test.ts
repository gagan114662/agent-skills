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
}

async function newOwner(): Promise<Owner> {
  const slug = `atool-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId };
}

describe("agent execution tools (#464)", () => {
  it("lists the execution-tool catalog with each tool's gated action and boundary", async () => {
    const owner = await newOwner();
    const res = await app.inject({
      method: "GET",
      url: "/me/agent-tools",
      cookies: { rid: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    const names = res.json().tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["ads.launch_campaign", "content.publish", "social.post"]);
    const publish = res.json().tools.find((t: { name: string }) => t.name === "content.publish");
    expect(publish.gatedAction).toBe("hosted.publish");
    expect(publish.visibility).toBe("public");
  });

  it("invoking a publish parks a PENDING #13 approval and never publishes autonomously", async () => {
    const owner = await newOwner();
    const res = await app.inject({
      method: "POST",
      url: "/me/agent-tools/content.publish/invoke",
      cookies: { rid: owner.cookie },
      payload: { args: { title: "Launch announcement", slug: "launch-announcement" } },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("pending_approval");
    expect(body.gatedAction).toBe("hosted.publish");
    expect(body.boundary).toBe("public");

    // The parked request exists, is PENDING (not executed), and carries routing-only payload (no body).
    const fetched = await app.inject({
      method: "GET",
      url: `/approvals/${body.approvalRequestId}`,
      cookies: { rid: owner.cookie },
    });
    expect(fetched.statusCode).toBe(200);
    const request = fetched.json();
    expect(request.status).toBe("pending");
    expect(request.actionType).toBe("hosted.publish");
    expect(request.payload).toMatchObject({ source: "agent-tools", slug: "launch-announcement" });
    expect(request.payload).not.toHaveProperty("title");
  });

  it("a budgeted ad launch parks a money approval carrying the exact amount", async () => {
    const owner = await newOwner();
    const res = await app.inject({
      method: "POST",
      url: "/me/agent-tools/ads.launch_campaign/invoke",
      cookies: { rid: owner.cookie },
      payload: { args: { campaignId: "spring-sale", dailyBudget: 400 } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().boundary).toBe("money");

    const request = (
      await app.inject({
        method: "GET",
        url: `/approvals/${res.json().approvalRequestId}`,
        cookies: { rid: owner.cookie },
      })
    ).json();
    expect(request.actionType).toBe("venture.ad_spend");
    expect(request.amount).toBe(400);
    expect(request.status).toBe("pending");
  });

  it("rejects an unknown tool (404) and invalid args (400) without parking anything", async () => {
    const owner = await newOwner();
    const unknown = await app.inject({
      method: "POST",
      url: "/me/agent-tools/delete.everything/invoke",
      cookies: { rid: owner.cookie },
      payload: { args: {} },
    });
    expect(unknown.statusCode).toBe(404);

    const invalid = await app.inject({
      method: "POST",
      url: "/me/agent-tools/content.publish/invoke",
      cookies: { rid: owner.cookie },
      payload: { args: { title: "no slug here" } },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
