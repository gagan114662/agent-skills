import { describe, it, expect } from "vitest";
import {
  decideAnalyticsInstall,
  isAnalyticsTagInstalled,
  resolveAnalyticsFlags,
  ANALYTICS_FLAGS_OFF,
  type AnalyticsConfigInput,
} from "../../src/analytics/decide.js";
import { analyticsTagSnippet, analyticsSnippetFingerprint } from "../../src/analytics/tag.js";

/**
 * #270 — the pure brain that decides how ipop's analytics tag reaches a site and whether the layer is on.
 * It must: pick the install path structurally (never from page content), default OFF owner-first, and build
 * a stable, vendor-correct snippet so Lens can report with no owner code work.
 */
describe("analytics install decision (#270)", () => {
  describe("decideAnalyticsInstall — structural install path", () => {
    it("injects the tag at render for an ipop-hosted page", () => {
      expect(decideAnalyticsInstall({ hosted: true, externalSiteConnected: false })).toBe(
        "hosted_auto_inject",
      );
    });
    it("installs through the connector for a connected external site", () => {
      expect(decideAnalyticsInstall({ hosted: false, externalSiteConnected: true })).toBe(
        "connector_inject",
      );
    });
    it("stays pending (claims nothing) with no hosting or connector", () => {
      expect(decideAnalyticsInstall({ hosted: false, externalSiteConnected: false })).toBe(
        "manual_pending",
      );
    });
    it("only hosted/connector methods count as a live tag", () => {
      expect(isAnalyticsTagInstalled("hosted_auto_inject")).toBe(true);
      expect(isAnalyticsTagInstalled("connector_inject")).toBe(true);
      expect(isAnalyticsTagInstalled("manual_pending")).toBe(false);
    });
  });

  describe("resolveAnalyticsFlags — default OFF, owner-workspace-first", () => {
    const OWNER = "ws-owner";
    it("is off when there is no config block", () => {
      expect(resolveAnalyticsFlags(undefined, OWNER)).toEqual(ANALYTICS_FLAGS_OFF);
    });
    it("is off when enabled is not explicitly true", () => {
      expect(resolveAnalyticsFlags({ ownerWorkspaceId: OWNER }, OWNER)).toEqual(ANALYTICS_FLAGS_OFF);
    });
    it("turning enabled on WITHOUT naming the owner workspace activates for nobody", () => {
      expect(resolveAnalyticsFlags({ enabled: true }, OWNER)).toEqual(ANALYTICS_FLAGS_OFF);
    });
    it("activates only the named owner workspace by default", () => {
      const cfg: AnalyticsConfigInput = { enabled: true, ownerWorkspaceId: OWNER, provider: "ga4" };
      expect(resolveAnalyticsFlags(cfg, OWNER).enabled).toBe(true);
      expect(resolveAnalyticsFlags(cfg, "ws-other")).toEqual(ANALYTICS_FLAGS_OFF);
    });
    it("broadens to all tenants when ownerWorkspaceOnly is false", () => {
      const cfg: AnalyticsConfigInput = { enabled: true, ownerWorkspaceOnly: false };
      expect(resolveAnalyticsFlags(cfg, "ws-anyone").enabled).toBe(true);
    });
    it("defaults the provider to dryrun and passes the measurement id through", () => {
      const flags = resolveAnalyticsFlags(
        { enabled: true, ownerWorkspaceId: OWNER, measurementId: "G-ABC123" },
        OWNER,
      );
      expect(flags.provider).toBe("dryrun");
      expect(flags.measurementId).toBe("G-ABC123");
    });
  });

  describe("analyticsTagSnippet — vendor-correct, no fabricated live tag", () => {
    it("builds a GA4 gtag snippet around the measurement id", () => {
      const snippet = analyticsTagSnippet("ga4", "G-ABC123");
      expect(snippet).toContain("googletagmanager.com/gtag/js?id=G-ABC123");
      expect(snippet).toContain("gtag('config','G-ABC123')");
    });
    it("builds a Plausible snippet around the domain", () => {
      expect(analyticsTagSnippet("plausible", "ipop.ai")).toContain('data-domain="ipop.ai"');
    });
    it("emits a placeholder (never a live tag) when no measurement id is set", () => {
      expect(analyticsTagSnippet("ga4", "")).toContain("pending measurement id");
    });
    it("fingerprint is stable and method-sensitive", () => {
      const snippet = analyticsTagSnippet("ga4", "G-ABC123");
      const a = analyticsSnippetFingerprint("hosted_auto_inject", snippet);
      const b = analyticsSnippetFingerprint("hosted_auto_inject", snippet);
      const c = analyticsSnippetFingerprint("connector_inject", snippet);
      expect(a).toBe(b);
      expect(a).not.toBe(c);
    });
  });
});
