import { describe, it, expect } from "vitest";
import {
  mintTrackingRef,
  refMatchesArtifact,
  buildTrackedUrl,
  recoverTrackingRef,
  TRACKING_REF_PREFIX,
  TRACKING_REF_PARAM,
} from "../../src/attribution/tracking.js";

describe("attribution/tracking — mintTrackingRef", () => {
  const input = { workspaceId: "ws-1", artifactId: "blog/launch", channel: "seo" };

  it("is deterministic and prefixed (stamping the same artifact is idempotent)", () => {
    const a = mintTrackingRef(input);
    const b = mintTrackingRef(input);
    expect(a).toBe(b);
    expect(a.startsWith(`${TRACKING_REF_PREFIX}_`)).toBe(true);
  });

  it("differs across workspace, artifact and channel", () => {
    const base = mintTrackingRef(input);
    expect(mintTrackingRef({ ...input, workspaceId: "ws-2" })).not.toBe(base);
    expect(mintTrackingRef({ ...input, artifactId: "blog/other" })).not.toBe(base);
    expect(mintTrackingRef({ ...input, channel: "social" })).not.toBe(base);
  });

  it("rejects blank components", () => {
    expect(() => mintTrackingRef({ ...input, artifactId: "  " })).toThrow();
    expect(() => mintTrackingRef({ ...input, workspaceId: "" })).toThrow();
    expect(() => mintTrackingRef({ ...input, channel: "" })).toThrow();
  });

  it("refMatchesArtifact verifies a recovered ref against its inputs", () => {
    const ref = mintTrackingRef(input);
    expect(refMatchesArtifact(ref, input)).toBe(true);
    expect(refMatchesArtifact(ref, { ...input, artifactId: "other" })).toBe(false);
  });
});

describe("attribution/tracking — buildTrackedUrl + recoverTrackingRef round-trip", () => {
  const utm = { source: "ipop", medium: "organic", campaign: "launch" };

  it("stamps utm + ref and recovers the same ref", () => {
    const ref = mintTrackingRef({ workspaceId: "ws-1", artifactId: "a1", channel: "seo" });
    const url = buildTrackedUrl("https://ipop.ai/pricing", ref, utm);
    expect(url).toContain("utm_source=ipop");
    expect(url).toContain("utm_medium=organic");
    expect(url).toContain("utm_campaign=launch");
    expect(url).toContain(`${TRACKING_REF_PARAM}=${ref}`);
    expect(recoverTrackingRef(url)).toBe(ref);
  });

  it("preserves an existing query and overwrites our params idempotently", () => {
    const ref = mintTrackingRef({ workspaceId: "ws-1", artifactId: "a1", channel: "seo" });
    const once = buildTrackedUrl("https://ipop.ai/p?plan=pro", ref, utm);
    const twice = buildTrackedUrl(once, ref, utm);
    expect(once).toContain("plan=pro");
    expect(twice).toBe(once); // re-stamping is a no-op
    expect(recoverTrackingRef(twice)).toBe(ref);
  });

  it("returns the input unchanged for a non-URL (never corrupts an artifact body)", () => {
    const ref = mintTrackingRef({ workspaceId: "ws-1", artifactId: "a1", channel: "seo" });
    expect(buildTrackedUrl("not a url", ref, utm)).toBe("not a url");
  });

  it("recovers from a bare query string", () => {
    const ref = mintTrackingRef({ workspaceId: "ws-1", artifactId: "a1", channel: "seo" });
    expect(recoverTrackingRef(`?${TRACKING_REF_PARAM}=${ref}`)).toBe(ref);
    expect(recoverTrackingRef(`${TRACKING_REF_PARAM}=${ref}`)).toBe(ref);
  });

  it("ignores a foreign or missing ref (a git ?ref= is not ours)", () => {
    expect(recoverTrackingRef("https://ipop.ai/p")).toBeNull();
    expect(recoverTrackingRef("https://example.com/x?ref=main")).toBeNull();
    expect(recoverTrackingRef(`https://ipop.ai/p?ref=${TRACKING_REF_PREFIX}_`)).toBeNull();
  });
});
