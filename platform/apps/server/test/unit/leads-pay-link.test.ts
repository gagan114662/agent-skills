import { describe, it, expect } from "vitest";
import {
  buildPayLinkSpec,
  buildTrackedPayUrl,
  PAY_LINK_UTM_MEDIUM,
} from "../../src/leads/pay-link.js";
import {
  mintTrackingRef,
  recoverTrackingRef,
  TRACKING_REF_PARAM,
  UTM_SOURCE_PARAM,
  UTM_MEDIUM_PARAM,
  UTM_CAMPAIGN_PARAM,
} from "../../src/attribution/tracking.js";

describe("leads pay-link — pure helper (GAP 3, ADR-0401)", () => {
  const ref = { workspaceId: "ws1", leadOrArtifactId: "lead-42", channel: "email" };

  it("mints a deterministic tracking ref equal to mintTrackingRef(workspace, lead, channel)", () => {
    const spec = buildPayLinkSpec(ref, { planId: "pro" }, "ipop");
    expect(spec.trackingRef).toBe(
      mintTrackingRef({ workspaceId: "ws1", artifactId: "lead-42", channel: "email" }),
    );
    // Same inputs always mint the same ref — re-minting is idempotent.
    expect(buildPayLinkSpec(ref, { planId: "pro" }, "ipop").trackingRef).toBe(spec.trackingRef);
  });

  it("puts the trackingRef in the link metadata (so the #98 webhook can recover it — GAP 2)", () => {
    const spec = buildPayLinkSpec(ref, { planId: "pro" }, "ipop");
    expect(spec.metadata).toEqual({ trackingRef: spec.trackingRef });
  });

  it("stamps utm {source, medium=outreach, campaign=planId}", () => {
    const spec = buildPayLinkSpec(ref, { planId: "agency" }, "ipop");
    expect(spec.utm).toEqual({ source: "ipop", medium: PAY_LINK_UTM_MEDIUM, campaign: "agency" });
  });

  it("wraps a hosted URL so the ref + utm ride in the query string (recoverable on landing)", () => {
    const spec = buildPayLinkSpec(ref, { planId: "pro" }, "ipop");
    const tracked = buildTrackedPayUrl("https://buy.stripe.com/abc123", spec);
    const url = new URL(tracked);
    expect(url.searchParams.get(TRACKING_REF_PARAM)).toBe(spec.trackingRef);
    expect(url.searchParams.get(UTM_SOURCE_PARAM)).toBe("ipop");
    expect(url.searchParams.get(UTM_MEDIUM_PARAM)).toBe(PAY_LINK_UTM_MEDIUM);
    expect(url.searchParams.get(UTM_CAMPAIGN_PARAM)).toBe("pro");
    // The ref recovered off the URL is exactly the one in the metadata — both halves agree.
    expect(recoverTrackingRef(tracked)).toBe(spec.trackingRef);
  });

  it("returns a non-URL hosted value unchanged (never corrupts the link)", () => {
    const spec = buildPayLinkSpec(ref, { planId: "pro" }, "ipop");
    expect(buildTrackedPayUrl("not a url", spec)).toBe("not a url");
  });

  it("is pure — different leads mint different refs, different channels too", () => {
    const a = buildPayLinkSpec(ref, { planId: "pro" }, "ipop").trackingRef;
    const b = buildPayLinkSpec(
      { ...ref, leadOrArtifactId: "lead-43" },
      { planId: "pro" },
      "ipop",
    ).trackingRef;
    const c = buildPayLinkSpec({ ...ref, channel: "x" }, { planId: "pro" }, "ipop").trackingRef;
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
