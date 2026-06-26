import { describe, it, expect } from "vitest";
import {
  decideConnectionView,
  decideInternalConnect,
  decideOneClickConnect,
  decideWaitlist,
} from "../../src/connections/view.js";
import {
  CONNECTION_DESCRIPTORS,
  EMAIL_CONNECTION_ID,
  getConnectionDescriptor,
  SOCIAL_AGGREGATOR_ID,
  SITE_PUBLISH_GITHUB_ID,
  WEBSITE_CONNECTION_ID,
} from "../../src/connections/registry.js";

/**
 * #258 — what Settings shows and what an internal paste is allowed to do. Customers see only OAuth-shaped
 * connectors; the GitHub paste is owner/admin only and refuses a non-owner or a customer (OAuth) connector.
 */
describe("decideConnectionView (#258)", () => {
  it("hides internal connectors from non-owner workspaces", () => {
    const view = decideConnectionView({
      descriptors: CONNECTION_DESCRIPTORS,
      connectedIds: new Set(),
      isOwner: false,
    });
    expect(view.every((v) => v.audience === "customer")).toBe(true);
    expect(view.find((v) => v.id === SITE_PUBLISH_GITHUB_ID)).toBeUndefined();
  });

  it("shows the internal GitHub connector to the owner workspace", () => {
    const view = decideConnectionView({
      descriptors: CONNECTION_DESCRIPTORS,
      connectedIds: new Set(),
      isOwner: true,
    });
    expect(view.find((v) => v.id === SITE_PUBLISH_GITHUB_ID)).toBeDefined();
  });

  it("marks connected connectors from the connected-id set", () => {
    const view = decideConnectionView({
      descriptors: CONNECTION_DESCRIPTORS,
      connectedIds: new Set(["google"]),
      isOwner: false,
    });
    expect(view.find((v) => v.id === "google")?.connected).toBe(true);
    expect(view.find((v) => v.id === "x")?.connected).toBe(false);
  });
});

describe("decideInternalConnect (#258)", () => {
  const gh = getConnectionDescriptor(SITE_PUBLISH_GITHUB_ID);

  it("seals the token + repo + base branch for the owner", () => {
    const d = decideInternalConnect({ descriptor: gh, isOwner: true, repo: "ipop/site", token: "ghp_x", baseBranch: "main" });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.serviceKey).toBe(SITE_PUBLISH_GITHUB_ID);
    expect(d.secrets.REALWORLD_GITHUB_TOKEN).toBe("ghp_x");
    expect(d.secrets.REALWORLD_SITE_REPO).toBe("ipop/site");
    expect(d.secrets.REALWORLD_SITE_BASE_BRANCH).toBe("main");
  });

  it("defaults the base branch to main", () => {
    const d = decideInternalConnect({ descriptor: gh, isOwner: true, repo: "ipop/site", token: "ghp_x" });
    expect(d.ok && d.secrets.REALWORLD_SITE_BASE_BRANCH).toBe("main");
  });

  it("refuses a non-owner (internal connection is admin only)", () => {
    const d = decideInternalConnect({ descriptor: gh, isOwner: false, repo: "ipop/site", token: "ghp_x" });
    expect(d).toMatchObject({ ok: false });
  });

  it("refuses an OAuth (customer) connector — paste is internal only", () => {
    const d = decideInternalConnect({
      descriptor: getConnectionDescriptor("google"),
      isOwner: true,
      repo: "ipop/site",
      token: "ghp_x",
    });
    expect(d).toMatchObject({ ok: false });
  });

  it("requires a repo shaped owner/repo and a token", () => {
    expect(decideInternalConnect({ descriptor: gh, isOwner: true, repo: "", token: "ghp_x" })).toMatchObject({ ok: false });
    expect(decideInternalConnect({ descriptor: gh, isOwner: true, repo: "noslash", token: "ghp_x" })).toMatchObject({ ok: false });
    expect(decideInternalConnect({ descriptor: gh, isOwner: true, repo: "ipop/site", token: "  " })).toMatchObject({ ok: false });
  });

  it("rejects path-traversal / out-of-charset repos (the repo is interpolated into a GitHub API URL)", () => {
    for (const repo of ["../foo", "owner/..", "owner/.", "owner/../etc", "ow ner/repo", "owner/re po", "a/b/c", "../../etc/passwd"]) {
      expect(decideInternalConnect({ descriptor: gh, isOwner: true, repo, token: "ghp_x" }), repo).toMatchObject({ ok: false });
    }
  });

  it("accepts valid GitHub owner/repo names (dots/underscores/hyphens in the repo part)", () => {
    for (const repo of ["ipop/site", "my-org/my.repo", "a/b_c-d.e", "Acme/Site_2"]) {
      expect(decideInternalConnect({ descriptor: gh, isOwner: true, repo, token: "ghp_x" }), repo).toMatchObject({ ok: true });
    }
  });

  it("refuses an unknown connection", () => {
    expect(decideInternalConnect({ descriptor: undefined, isOwner: true, repo: "ipop/site", token: "x" })).toMatchObject({ ok: false });
  });
});

describe("decideOneClickConnect (#529/#507)", () => {
  it("connects available one-click customer connectors with no secret (#1070)", () => {
    for (const [id, kind, scope] of [
      [EMAIL_CONNECTION_ID, "esp", "send_email"],
      [SOCIAL_AGGREGATOR_ID, "ad_account", "post_social"],
      [WEBSITE_CONNECTION_ID, "hosting", "site_publish"],
    ] as const) {
      const d = decideOneClickConnect({ descriptor: getConnectionDescriptor(id) });
      expect(d.ok, id).toBe(true);
      if (!d.ok) continue;
      expect(d.serviceKey).toBe(id);
      expect(d.serviceKind).toBe(kind);
      expect(d.scopes).toContain(scope);
      expect("secrets" in d).toBe(false);
    }
  });

  it("refuses an OAuth connector (it isn't a one-click connect)", () => {
    expect(decideOneClickConnect({ descriptor: getConnectionDescriptor("google") })).toMatchObject({ ok: false });
  });

  it("refuses the internal paste connector", () => {
    expect(decideOneClickConnect({ descriptor: getConnectionDescriptor(SITE_PUBLISH_GITHUB_ID) })).toMatchObject({ ok: false });
  });

  it("refuses an unknown connection", () => {
    expect(decideOneClickConnect({ descriptor: undefined })).toMatchObject({ ok: false });
  });
});

describe("decideWaitlist (#507)", () => {
  it("accepts a coming-soon customer connector (a next step instead of a dead stop)", () => {
    const d = decideWaitlist({ descriptor: getConnectionDescriptor("google") });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.connectionId).toBe("google");
    expect(d.provider).toBe("google");
  });

  it("refuses an already-available connector (connect it, don't waitlist it)", () => {
    expect(decideWaitlist({ descriptor: getConnectionDescriptor(EMAIL_CONNECTION_ID) })).toMatchObject({ ok: false });
    expect(decideWaitlist({ descriptor: getConnectionDescriptor(SOCIAL_AGGREGATOR_ID) })).toMatchObject({ ok: false });
    expect(decideWaitlist({ descriptor: getConnectionDescriptor(WEBSITE_CONNECTION_ID) })).toMatchObject({ ok: false });
  });

  it("refuses an internal connector (never customer-facing)", () => {
    expect(decideWaitlist({ descriptor: getConnectionDescriptor(SITE_PUBLISH_GITHUB_ID) })).toMatchObject({ ok: false });
  });

  it("refuses an unknown connection", () => {
    expect(decideWaitlist({ descriptor: undefined })).toMatchObject({ ok: false });
  });
});
