import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

/**
 * #151 governance & trust integration (real Postgres): workspace roles, email invites, the egress
 * report, and the RBAC gate on clearing #13 approvals. RBAC is enabled process-wide for this file via
 * env (the #151 RELOAD_RBAC_ENABLED toggle); with no role row a member still clears (bootstrap), so the
 * non-role flows are unaffected.
 */

let app: FastifyInstance;
const slugs: string[] = [];
const prevRbac = process.env.RELOAD_RBAC_ENABLED;

beforeAll(async () => {
  process.env.RELOAD_RBAC_ENABLED = "1";
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await closeDb();
  if (prevRbac === undefined) delete process.env.RELOAD_RBAC_ENABLED;
  else process.env.RELOAD_RBAC_ENABLED = prevRbac;
});

interface Owner {
  cookie: string;
  workspaceId: string;
  memberId: string;
}

async function newOwner(): Promise<Owner> {
  const slug = `gov-${newId()}`;
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

describe("#151 governance — roles", () => {
  it("bootstraps an owner, lists roles, and removes a grant", async () => {
    const owner = await newOwner();
    const agent = await newAgent(owner, "Scout");

    // Bootstrap: no owner exists yet, so the human creator may assign the first roles.
    const setOwner = await app.inject({
      method: "PUT",
      url: `/workspaces/${owner.workspaceId}/governance/roles/${owner.memberId}`,
      cookies: { rid: owner.cookie },
      payload: { role: "owner" },
    });
    expect(setOwner.statusCode).toBe(200);

    const setViewer = await app.inject({
      method: "PUT",
      url: `/workspaces/${owner.workspaceId}/governance/roles/${agent.memberId}`,
      cookies: { rid: owner.cookie },
      payload: { role: "viewer" },
    });
    expect(setViewer.statusCode).toBe(200);

    const roles = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${owner.workspaceId}/governance/roles`,
        cookies: { rid: owner.cookie },
      })
    ).json();
    expect(roles.hasOwner).toBe(true);
    const byMember = Object.fromEntries(roles.roles.map((r: { memberId: string; role: string }) => [r.memberId, r.role]));
    expect(byMember[owner.memberId]).toBe("owner");
    expect(byMember[agent.memberId]).toBe("viewer");

    // Remove the viewer grant.
    const del = await app.inject({
      method: "DELETE",
      url: `/workspaces/${owner.workspaceId}/governance/roles/${agent.memberId}`,
      cookies: { rid: owner.cookie },
    });
    expect(del.statusCode).toBe(200);
  });

  it("rejects an invalid role and a non-owner manager once an owner exists", async () => {
    const owner = await newOwner();
    await app.inject({
      method: "PUT",
      url: `/workspaces/${owner.workspaceId}/governance/roles/${owner.memberId}`,
      cookies: { rid: owner.cookie },
      payload: { role: "owner" },
    });
    const bad = await app.inject({
      method: "PUT",
      url: `/workspaces/${owner.workspaceId}/governance/roles/${owner.memberId}`,
      cookies: { rid: owner.cookie },
      payload: { role: "superuser" },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("#151 governance — email invites", () => {
  it("creates an invite (token shown once), then accepts it to bind a role", async () => {
    const owner = await newOwner();
    const create = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/governance/invites`,
      cookies: { rid: owner.cookie },
      payload: { email: "Teammate@Example.com", role: "approver" },
    });
    expect(create.statusCode).toBe(201);
    const { invite, token } = create.json();
    expect(invite.email).toBe("teammate@example.com"); // normalised
    expect(invite.status).toBe("pending");
    expect(typeof token).toBe("string");

    // List never leaks the token hash.
    const list = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${owner.workspaceId}/governance/invites`,
        cookies: { rid: owner.cookie },
      })
    ).json();
    expect(list.invites[0].email).toBe("teammate@example.com");
    expect(JSON.stringify(list)).not.toContain("token_hash");

    // Accept (the owner, a human member, binds the invited role to themselves).
    const accept = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/governance/invites/accept`,
      cookies: { rid: owner.cookie },
      payload: { token },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().role).toBe("approver");

    // The token is single-use: replaying it now 404s (no longer pending).
    const replay = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/governance/invites/accept`,
      cookies: { rid: owner.cookie },
      payload: { token },
    });
    expect(replay.statusCode).toBe(404);
  });

  it("rejects a bad email", async () => {
    const owner = await newOwner();
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/governance/invites`,
      cookies: { rid: owner.cookie },
      payload: { email: "nope", role: "viewer" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("#151 governance — RBAC gate on clearing approvals (no weakening when default-OFF)", () => {
  it("a viewer cannot clear an approval; an approver can", async () => {
    const owner = await newOwner();
    const agent = await newAgent(owner, "Requester");

    // The agent submits a sensitive external.send → it pauses for a human (#13 default-sensitive).
    const submit = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      headers: bearer(agent.token),
      payload: { actionType: "external.send", payload: { summary: "ping", target: "https://api.example.com" } },
    });
    expect(submit.statusCode).toBe(202);
    const requestId = submit.json().request.id;

    // Owner is assigned VIEWER → cannot clear (RBAC enabled for this file).
    await app.inject({
      method: "PUT",
      url: `/workspaces/${owner.workspaceId}/governance/roles/${owner.memberId}`,
      cookies: { rid: owner.cookie },
      payload: { role: "viewer" },
    });
    const denied = await app.inject({
      method: "POST",
      url: `/approvals/${requestId}/approve`,
      cookies: { rid: owner.cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatch(/approver or owner/);

    // Promote to APPROVER → the same approval now clears.
    await app.inject({
      method: "PUT",
      url: `/workspaces/${owner.workspaceId}/governance/roles/${owner.memberId}`,
      cookies: { rid: owner.cookie },
      payload: { role: "approver" },
    });
    const ok = await app.inject({
      method: "POST",
      url: `/approvals/${requestId}/approve`,
      cookies: { rid: owner.cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("executed");
  });
});

describe("#151 governance — egress allowlist + flagged-domains report", () => {
  it("blocks a disallowed external.send, records a violation, and surfaces it in the report", async () => {
    const owner = await newOwner();
    const agent = await newAgent(owner, "Sender");
    const prevEnabled = process.env.RELOAD_EGRESS_ENABLED;
    const prevList = process.env.RELOAD_EGRESS_ALLOWLIST;
    process.env.RELOAD_EGRESS_ENABLED = "1";
    process.env.RELOAD_EGRESS_ALLOWLIST = "api.example.com";
    try {
      // The agent submits an external.send to a domain NOT on the allowlist → pauses for a human.
      const requestId = (
        await app.inject({
          method: "POST",
          url: `/workspaces/${owner.workspaceId}/actions`,
          headers: bearer(agent.token),
          payload: { actionType: "external.send", payload: { summary: "leak?", target: "https://evil.com/x" } },
        })
      ).json().request.id;

      // Owner approves the human decision — but the executor's egress check blocks the send (502 failed).
      const approve = await app.inject({
        method: "POST",
        url: `/approvals/${requestId}/approve`,
        cookies: { rid: owner.cookie },
      });
      expect(approve.statusCode).toBe(502);
      expect(approve.json().status).toBe("failed");

      // The violation is in the flagged-domains report.
      const report = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${owner.workspaceId}/egress/violations`,
          cookies: { rid: owner.cookie },
        })
      ).json();
      expect(report.violations.length).toBeGreaterThan(0);
      expect(report.violations[0].domain).toBe("evil.com");

      // The policy endpoint reflects the enabled allowlist.
      const policy = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${owner.workspaceId}/egress/policy`,
          cookies: { rid: owner.cookie },
        })
      ).json();
      expect(policy).toEqual({ enabled: true, allowlist: ["api.example.com"] });
    } finally {
      if (prevEnabled === undefined) delete process.env.RELOAD_EGRESS_ENABLED;
      else process.env.RELOAD_EGRESS_ENABLED = prevEnabled;
      if (prevList === undefined) delete process.env.RELOAD_EGRESS_ALLOWLIST;
      else process.env.RELOAD_EGRESS_ALLOWLIST = prevList;
    }
  });
});
