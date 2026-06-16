import { describe, it, expect } from "vitest";
import { decideConnectionView, decideInternalConnect } from "../../src/connections/view.js";
import { CONNECTION_DESCRIPTORS, getConnectionDescriptor, SITE_PUBLISH_GITHUB_ID } from "../../src/connections/registry.js";

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

  it("refuses an unknown connection", () => {
    expect(decideInternalConnect({ descriptor: undefined, isOwner: true, repo: "ipop/site", token: "x" })).toMatchObject({ ok: false });
  });
});
