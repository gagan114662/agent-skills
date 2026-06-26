import { describe, it, expect, afterAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { resolveServiceSecrets } from "../../src/db/repositories/external-credentials.js";

/**
 * #258 — the connect-once integrations surface, end-to-end on a real Postgres.
 *
 * Proves the acceptance the issue calls out:
 *  - A customer (non-owner) workspace NEVER sees the internal GitHub repo/token path, and can't paste it.
 *  - ipop's OWN (owner) workspace connects site publishing once; the token is sealed into the encrypted
 *    #192 vault (resolvable server-side, never echoed to the client) — so `publish_site` no longer needs a
 *    Fly server secret.
 */
const app = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

afterEach(() => {
  delete process.env.RELOAD_MARKETING_OWNER_WORKSPACE_ID;
});

async function seed(): Promise<{ cookie: string; workspaceId: string }> {
  const slug = `conn-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId };
}

describe("connections (#258) — customer view never pastes a token, GitHub paste is admin", () => {
  it("a customer (non-owner) workspace sees only no-paste connectors and cannot paste a token", async () => {
    const { cookie } = await seed();

    const list = await app.inject({
      method: "GET",
      url: "/me/connections",
      cookies: { rid: cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.canManageInternal).toBe(false);
    // No internal GitHub connector is exposed; every visible connector is a no-paste consumer connect
    // (consumer OAuth, or the one-click outbound-email consent #529) — never the admin paste path.
    expect(
      body.connections.find((c: { id: string }) => c.id === "site_publish_github"),
    ).toBeUndefined();
    expect(body.connections.every((c: { auth: string }) => c.auth !== "paste_internal")).toBe(true);
    expect(body.connections.find((c: { id: string }) => c.id === "google")).toBeDefined();
    expect(body.connections.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining(["imessage"]),
    );
    expect(body.connections.find((c: { id: string }) => c.id === "imessage")).toMatchObject({
      auth: "one_click",
      status: "available",
      capabilities: expect.arrayContaining(["work_visibility", "imessage_room"]),
    });

    // Pasting the internal connection is refused for a non-owner.
    const connect = await app.inject({
      method: "POST",
      url: "/me/connections/site_publish_github/connect",
      cookies: { rid: cookie },
      payload: { repo: "ipop/site", token: "ghp_secret" },
    });
    expect(connect.statusCode).toBe(400);

    // Revoking an internal connection is also admin-only — a non-owner gets 403, not a silent revoke.
    const del = await app.inject({
      method: "DELETE",
      url: "/me/connections/site_publish_github",
      cookies: { rid: cookie },
    });
    expect(del.statusCode).toBe(403);
  });

  it("a customer can finish onboarding: one-click connecting email flips the account to connected (#529/#507)", async () => {
    const { cookie, workspaceId } = await seed();

    // Before: outbound email is offered as an AVAILABLE one-click connector, not yet connected.
    const before = (
      await app.inject({ method: "GET", url: "/me/connections", cookies: { rid: cookie } })
    ).json();
    const email = before.connections.find((c: { id: string }) => c.id === "email");
    expect(email).toMatchObject({ auth: "one_click", status: "available", connected: false });

    // One-click connect — no redirect, no pasted secret.
    const enable = await app.inject({
      method: "POST",
      url: "/me/connections/email/enable",
      cookies: { rid: cookie },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().connected).toBe(true);

    // After: the account reads connected, so the "connect an account" onboarding step is now completable.
    const after = (
      await app.inject({ method: "GET", url: "/me/connections", cookies: { rid: cookie } })
    ).json();
    expect(
      after.connections.some(
        (c: { id: string; connected: boolean }) => c.id === "email" && c.connected,
      ),
    ).toBe(true);

    // Disconnect → goes back to not-connected, gracefully.
    const del = await app.inject({
      method: "DELETE",
      url: "/me/connections/email",
      cookies: { rid: cookie },
    });
    expect(del.statusCode).toBe(200);
    const gone = (
      await app.inject({ method: "GET", url: "/me/connections", cookies: { rid: cookie } })
    ).json();
    expect(
      gone.connections.some(
        (c: { id: string; connected: boolean }) => c.id === "email" && c.connected,
      ),
    ).toBe(false);

    // #928: connect + revoke are now first-class audit events with actor/timestamp/service metadata.
    const audit = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/audit`,
        cookies: { rid: cookie },
      })
    ).json();
    const credentialEvents = audit.filter((e: { source: string }) => e.source === "credential");
    expect(credentialEvents.map((e: { kind: string }) => e.kind)).toEqual([
      "credential.revoked",
      "credential.connected",
    ]);
    expect(credentialEvents[0]).toMatchObject({
      actorMemberId: expect.any(String),
      summary: "email credentials revoked scopes=send_email",
      status: "revoked",
    });
    expect(credentialEvents[1]).toMatchObject({
      actorMemberId: expect.any(String),
      summary: "email credentials connected scopes=send_email",
      status: "connected",
    });
  });

  it("enabling a not-yet-available connector is refused; a coming-soon connector offers the waitlist instead (#507)", async () => {
    const { cookie } = await seed();

    // You can't one-click a connector whose live flow isn't wired yet.
    const badEnable = await app.inject({
      method: "POST",
      url: "/me/connections/google/enable",
      cookies: { rid: cookie },
    });
    expect(badEnable.statusCode).toBe(400);

    // But it's not a dead stop — joining the waitlist is the next step (202 accepted).
    const wait = await app.inject({
      method: "POST",
      url: "/me/connections/google/waitlist",
      cookies: { rid: cookie },
    });
    expect(wait.statusCode).toBe(202);
    expect(wait.json()).toMatchObject({ status: "waitlisted", id: "google" });

    // An already-available connector can't be waitlisted (connect it instead).
    const noWait = await app.inject({
      method: "POST",
      url: "/me/connections/email/waitlist",
      cookies: { rid: cookie },
    });
    expect(noWait.statusCode).toBe(400);
  });

  it("an OAuth connector's start is an honest 'coming soon' (501), never a silent success", async () => {
    const { cookie } = await seed();
    const res = await app.inject({
      method: "POST",
      url: "/me/connections/google/oauth/start",
      cookies: { rid: cookie },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().status).toBe("coming_soon");
  });

  it("the owner workspace connects site publishing once; the token is sealed and never echoed", async () => {
    const { cookie, workspaceId } = await seed();
    process.env.RELOAD_MARKETING_OWNER_WORKSPACE_ID = workspaceId; // loadConfig reads env live

    // Owner sees the internal connector.
    const list = (
      await app.inject({ method: "GET", url: "/me/connections", cookies: { rid: cookie } })
    ).json();
    expect(list.canManageInternal).toBe(true);
    const gh = list.connections.find((c: { id: string }) => c.id === "site_publish_github");
    expect(gh).toBeDefined();
    expect(gh.connected).toBe(false);

    // Connect once.
    const connect = await app.inject({
      method: "POST",
      url: "/me/connections/site_publish_github/connect",
      cookies: { rid: cookie },
      payload: { repo: "ipop/site", token: "ghp_internal_secret", baseBranch: "main" },
    });
    expect(connect.statusCode).toBe(200);
    const cbody = connect.json();
    expect(cbody.connected).toBe(true);
    // The connect/list responses NEVER carry the secret value.
    expect(JSON.stringify(cbody)).not.toContain("ghp_internal_secret");

    // It now reads connected, still no secret leaked.
    const after = (
      await app.inject({ method: "GET", url: "/me/connections", cookies: { rid: cookie } })
    ).json();
    expect(
      after.connections.find((c: { id: string }) => c.id === "site_publish_github").connected,
    ).toBe(true);
    expect(JSON.stringify(after)).not.toContain("ghp_internal_secret");

    // The token + repo are sealed in the encrypted vault — resolvable server-side (what publish_site reads),
    // so there is no Fly server secret anymore.
    const secrets = await resolveServiceSecrets(workspaceId, "site_publish_github");
    expect(secrets.REALWORLD_GITHUB_TOKEN).toBe("ghp_internal_secret");
    expect(secrets.REALWORLD_SITE_REPO).toBe("ipop/site");

    // Disconnect → goes offline gracefully.
    const del = await app.inject({
      method: "DELETE",
      url: "/me/connections/site_publish_github",
      cookies: { rid: cookie },
    });
    expect(del.statusCode).toBe(200);
    const gone = await resolveServiceSecrets(workspaceId, "site_publish_github");
    expect(gone.REALWORLD_GITHUB_TOKEN).toBeUndefined();
  });
});
