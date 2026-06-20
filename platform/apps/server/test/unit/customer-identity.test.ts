import { describe, it, expect } from "vitest";
import {
  resolveCustomerIdentity,
  sanitizeIdentityText,
  sanitizeAvatarUrl,
  MAX_IDENTITY_TEXT_CHARS,
} from "../../src/identity/customer-identity.js";
import type { CustomerIdentityConfig } from "../../src/config/schema.js";

const OWNER = "ws-owner";

/** A complete, active owner config — the happy path the rest mutate from. */
function activeCfg(over: Partial<CustomerIdentityConfig> = {}): CustomerIdentityConfig {
  return {
    enabled: true,
    ownerWorkspaceId: OWNER,
    founderName: "Ada Founder",
    avatarUrl: "https://cdn.example.com/ada.png",
    voiceProfileId: "voice_ada_v1",
    tagline: "Building in public.",
    ...over,
  };
}

describe("identity/customer-identity — resolveCustomerIdentity", () => {
  it("is OFF by default: no block ⇒ null", () => {
    expect(resolveCustomerIdentity(undefined, OWNER)).toBeNull();
    expect(resolveCustomerIdentity({}, OWNER)).toBeNull();
    expect(resolveCustomerIdentity({ enabled: false, ownerWorkspaceId: OWNER }, OWNER)).toBeNull();
  });

  it("fail-closed: enabled but no owner named (named-nobody) ⇒ null", () => {
    expect(resolveCustomerIdentity({ enabled: true, founderName: "Ada" }, OWNER)).toBeNull();
  });

  it("fail-closed: enabled + owner named, but a non-owner caller ⇒ null", () => {
    expect(resolveCustomerIdentity(activeCfg(), "ws-other")).toBeNull();
  });

  it("returns the identity for the owner when enabled", () => {
    const identity = resolveCustomerIdentity(activeCfg(), OWNER);
    expect(identity).toEqual({
      founderName: "Ada Founder",
      avatarUrl: "https://cdn.example.com/ada.png",
      voiceProfileId: "voice_ada_v1",
      tagline: "Building in public.",
    });
  });

  it("no presentable name ⇒ null (no credible face without a name)", () => {
    expect(resolveCustomerIdentity(activeCfg({ founderName: undefined }), OWNER)).toBeNull();
    expect(resolveCustomerIdentity(activeCfg({ founderName: "   " }), OWNER)).toBeNull();
  });

  it("sanitizes founderName and tagline for display (control chars stripped)", () => {
    const dirty = `Ada${String.fromCharCode(7)}${String.fromCharCode(0)}\nFounder`;
    const identity = resolveCustomerIdentity(
      activeCfg({ founderName: dirty, tagline: `tag${String.fromCharCode(27)}line` }),
      OWNER,
    );
    expect(identity?.founderName).toBe("Ada Founder");
    expect(identity?.founderName).not.toContain(String.fromCharCode(7));
    expect(identity?.tagline).toBe("tag line");
  });

  it("caps founderName length", () => {
    const long = "x".repeat(MAX_IDENTITY_TEXT_CHARS + 50);
    const identity = resolveCustomerIdentity(activeCfg({ founderName: long }), OWNER);
    expect(identity?.founderName.length).toBeLessThanOrEqual(MAX_IDENTITY_TEXT_CHARS + 1); // +1 for the ellipsis
    expect(identity?.founderName.endsWith("…")).toBe(true);
  });

  it("omits a malformed avatar URL (not http(s)) — identity still resolves", () => {
    expect(resolveCustomerIdentity(activeCfg({ avatarUrl: "not a url" }), OWNER)?.avatarUrl).toBeNull();
    expect(
      resolveCustomerIdentity(activeCfg({ avatarUrl: "javascript:alert(1)" }), OWNER)?.avatarUrl,
    ).toBeNull();
    expect(resolveCustomerIdentity(activeCfg({ avatarUrl: "ftp://x/y.png" }), OWNER)?.avatarUrl).toBeNull();
  });

  it("treats an absent voiceProfileId / tagline as null", () => {
    const identity = resolveCustomerIdentity(
      activeCfg({ voiceProfileId: undefined, tagline: undefined }),
      OWNER,
    );
    expect(identity?.voiceProfileId).toBeNull();
    expect(identity?.tagline).toBeNull();
  });
});

describe("identity/customer-identity — pure helpers", () => {
  it("sanitizeIdentityText collapses whitespace, trims, strips C0/C1", () => {
    expect(sanitizeIdentityText("  a\t\t b  ")).toBe("a b");
    expect(sanitizeIdentityText("")).toBe("");
    expect(sanitizeIdentityText(`x${String.fromCharCode(155)}y`)).toBe("x y");
  });

  it("sanitizeAvatarUrl accepts http(s), rejects everything else", () => {
    expect(sanitizeAvatarUrl("https://a.com/x.png")).toBe("https://a.com/x.png");
    expect(sanitizeAvatarUrl("http://a.com/x.png")).toBe("http://a.com/x.png");
    expect(sanitizeAvatarUrl("")).toBeNull();
    expect(sanitizeAvatarUrl("   ")).toBeNull();
    expect(sanitizeAvatarUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(sanitizeAvatarUrl("/relative/path.png")).toBeNull();
  });
});
