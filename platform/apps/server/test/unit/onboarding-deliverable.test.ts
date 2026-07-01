import { describe, it, expect } from "vitest";
import {
  brandNameFromHost,
  buildDeliverable,
  buildDeliverableForBusiness,
  deriveBusiness,
  parseSiteSnapshot,
  planToFrames,
  type SiteSnapshot,
} from "../../src/onboarding/deliverable.js";

/**
 * Unit test for the #633 outcome-first deliverable generator. It must turn an untrusted typed URL into a
 * normalized business identity, refuse non-web junk, and build a personalized, deterministic artifact whose
 * frames stream header → sections → done.
 */

describe("deriveBusiness (#633)", () => {
  it("accepts a bare domain and normalizes it", () => {
    expect(deriveBusiness("acme.com")).toEqual({ url: "https://acme.com", host: "acme.com", name: "Acme" });
  });

  it("strips www, lower-cases the host, and keeps a path", () => {
    expect(deriveBusiness("HTTPS://WWW.Acme.com/pricing")).toEqual({
      url: "https://acme.com/pricing",
      host: "acme.com",
      name: "Acme",
    });
  });

  it("derives a title-cased name from a hyphenated label", () => {
    expect(deriveBusiness("good-burger.io")?.name).toBe("Good Burger");
  });

  it("rejects empty, non-string, over-long, schemeless-junk, and non-web-scheme inputs", () => {
    expect(deriveBusiness("")).toBeNull();
    expect(deriveBusiness("   ")).toBeNull();
    expect(deriveBusiness(42)).toBeNull();
    expect(deriveBusiness("localhost")).toBeNull(); // no dot → not a domain
    expect(deriveBusiness("127.0.0.1")).toBeNull();
    expect(deriveBusiness("not a domain")).toBeNull();
    expect(deriveBusiness("javascript:alert(1)")).toBeNull();
    expect(deriveBusiness("file:///etc/passwd")).toBeNull();
    expect(deriveBusiness("a".repeat(3000) + ".com")).toBeNull();
  });

  it("sanitizes the derived brand name (no markup-ish characters survive)", () => {
    // The host parser already drops illegal host chars; brandNameFromHost is the last line of defense.
    expect(brandNameFromHost("<script>.com")).not.toContain("<");
    expect(brandNameFromHost("a".repeat(80))).toHaveLength(40);
  });
});

const snapshot: SiteSnapshot = {
  sourceUrl: "https://acme.com/",
  status: 200,
  title: "Acme Scheduling — book more demos",
  description: "Acme helps B2B teams qualify leads and book better demo calls.",
  h1: "Book better demo calls",
  ctas: ["Book a demo", "Start free"],
  keywords: ["demo", "calls", "leads"],
};

describe("parseSiteSnapshot (#1530)", () => {
  it("extracts bounded page facts from public homepage HTML", () => {
    const parsed = parseSiteSnapshot(
      "https://acme.com/",
      200,
      `<!doctype html><title>Acme Growth</title><meta name="description" content="Pipeline tools for SaaS teams"><h1>Turn intent into pipeline</h1><a href="/demo">Book a demo</a>`,
    );

    expect(parsed).toMatchObject({
      sourceUrl: "https://acme.com/",
      status: 200,
      title: "Acme Growth",
      description: "Pipeline tools for SaaS teams",
      h1: "Turn intent into pipeline",
      ctas: ["Book a demo"],
    });
  });

  it("returns null instead of fabricating when HTML has no useful facts", () => {
    expect(parseSiteSnapshot("https://acme.com/", 200, "<html><body></body></html>")).toBeNull();
  });
});

describe("buildDeliverable (#633)", () => {
  const business = deriveBusiness("acme.com")!;

  it("is personalized: brand name and host appear in the artifact", () => {
    const plan = buildDeliverable(business, snapshot);
    expect(plan.title).toContain("Acme");
    expect(plan.subtitle).toContain("https://acme.com/");
    const blob = plan.sections.map((s) => s.heading + s.body).join("\n");
    expect(blob).toContain("Acme");
    expect(blob).toContain("acme.com");
    expect(blob).toContain("Book better demo calls");
    expect(blob).toContain("Book a demo");
  });

  it("produces concrete, multi-kind sections (insight + action + draft)", () => {
    const kinds = new Set(buildDeliverable(business, snapshot).sections.map((s) => s.kind));
    expect(kinds).toContain("insight");
    expect(kinds).toContain("action");
    expect(kinds).toContain("draft");
  });

  it("is deterministic for the same business", () => {
    expect(buildDeliverable(business, snapshot)).toEqual(buildDeliverable(deriveBusiness("acme.com")!, snapshot));
  });

  it("uses the site reader and returns null when the site cannot be read", async () => {
    await expect(buildDeliverableForBusiness(business, async () => snapshot)).resolves.toMatchObject({
      siteRead: snapshot,
    });
    await expect(buildDeliverableForBusiness(business, async () => null)).resolves.toBeNull();
  });
});

describe("planToFrames (#633)", () => {
  it("emits start → one section per section → done, in order", () => {
    const plan = buildDeliverable(deriveBusiness("acme.com")!, snapshot);
    const frames = planToFrames(plan);
    expect(frames[0].event).toBe("start");
    expect(frames.at(-1)?.event).toBe("done");
    const sectionFrames = frames.filter((f) => f.event === "section");
    expect(sectionFrames).toHaveLength(plan.sections.length);
    expect(sectionFrames.map((f) => (f.data as { index: number }).index)).toEqual(
      plan.sections.map((_, i) => i),
    );
  });
});
