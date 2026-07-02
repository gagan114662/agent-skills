import { describe, it, expect, vi } from "vitest";
import {
  brandNameFromHost,
  buildDeliverable,
  buildDeliverableForBusiness,
  deriveBusiness,
  parseSiteSnapshot,
  planToFrames,
  readSiteSnapshot,
  type SiteSnapshot,
} from "../../src/onboarding/deliverable.js";
import type { HostResolver, PublicWebFetch } from "../../src/security/public-web-url.js";

/**
 * Unit test for the #633 outcome-first deliverable generator. It must turn an untrusted typed URL into a
 * normalized business identity, refuse non-web junk, and build a personalized, deterministic artifact whose
 * frames stream header → sections → done.
 */

describe("deriveBusiness (#633)", () => {
  it("accepts a bare domain and normalizes it", () => {
    expect(deriveBusiness("acme.com")).toEqual({
      url: "https://acme.com",
      host: "acme.com",
      name: "Acme",
    });
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
    expect(deriveBusiness("http://2130706433")).toBeNull();
    expect(deriveBusiness("http://0x7f000001")).toBeNull();
    expect(deriveBusiness("http://127.1")).toBeNull();
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

  it("keeps Unicode keywords from non-English homepages", () => {
    const parsed = parseSiteSnapshot(
      "https://ejemplo.mx/",
      200,
      '<!doctype html><title>Café niños</title><meta name="description" content="营销 creadores"><h1>营销</h1>',
    );

    expect(parsed?.keywords).toEqual(
      expect.arrayContaining(["café", "niños", "营销", "creadores"]),
    );
  });
});

const publicResolver: HostResolver = async (hostname) => {
  if (hostname === "private.example") return [{ address: "10.0.0.8", family: 4 }];
  if (hostname === "loopback-v6.example") return [{ address: "::1", family: 6 }];
  return [{ address: "93.184.216.34", family: 4 }];
};

function htmlResponse(body = "<title>Acme Growth</title><h1>Book better demos</h1>"): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

describe("readSiteSnapshot SSRF guard (#1530)", () => {
  it("resolves the hostname and refuses private DNS answers before fetching", async () => {
    const fetchImpl = vi.fn<PublicWebFetch>();
    const resolver: HostResolver = async () => [{ address: "192.168.1.10", family: 4 }];

    await expect(
      readSiteSnapshot(
        { url: "http://private.example", host: "private.example", name: "Private" },
        fetchImpl,
        resolver,
      ),
    ).resolves.toBeNull();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["0/8", "0.1.2.3", 4],
    ["10/8", "10.2.3.4", 4],
    ["127/8", "127.10.20.30", 4],
    ["172.16/12", "172.20.1.1", 4],
    ["192.168/16", "192.168.1.10", 4],
    ["169.254/16 metadata", "169.254.169.254", 4],
    ["IPv6 loopback", "::1", 6],
    ["IPv6 unique local", "fc00::1", 6],
    ["IPv6 mapped metadata", "::ffff:169.254.169.254", 6],
  ])("blocks %s DNS answers before fetching", async (_label, address, family) => {
    const fetchImpl = vi.fn<PublicWebFetch>();
    const resolver: HostResolver = async () => [
      { address: String(address), family: Number(family) },
    ];

    await expect(
      readSiteSnapshot(
        { url: "https://public.example", host: "public.example", name: "Public" },
        fetchImpl,
        resolver,
      ),
    ).resolves.toBeNull();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-standard ports before fetching", async () => {
    const fetchImpl = vi.fn<PublicWebFetch>();

    await expect(
      readSiteSnapshot(
        { url: "https://acme.com:8443", host: "acme.com", name: "Acme" },
        fetchImpl,
        publicResolver,
      ),
    ).resolves.toBeNull();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates each redirect hop and blocks private destinations", async () => {
    const fetchImpl = vi.fn<PublicWebFetch>(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://private.example/admin" },
      });
    });

    await expect(
      readSiteSnapshot(
        { url: "http://acme.com", host: "acme.com", name: "Acme" },
        fetchImpl,
        publicResolver,
      ),
    ).resolves.toBeNull();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://acme.com/",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("blocks hex and abbreviated numeric redirect hosts before URL normalization can hide them", async () => {
    const fetchImpl = vi.fn<PublicWebFetch>(async () => {
      return new Response(null, { status: 302, headers: { location: "http://2130706433/secret" } });
    });

    await expect(
      readSiteSnapshot(
        { url: "http://acme.com", host: "acme.com", name: "Acme" },
        fetchImpl,
        publicResolver,
      ),
    ).resolves.toBeNull();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows safe redirects and parses the final public page", async () => {
    const fetchImpl = vi.fn<PublicWebFetch>(async (url) => {
      if (url === "https://acme.com/") {
        return new Response(null, { status: 301, headers: { location: "/landing" } });
      }
      return htmlResponse(
        "<title>Acme Landing</title><h1>Turn visitors into pipeline</h1><a>Book a demo</a>",
      );
    });

    await expect(
      readSiteSnapshot(
        { url: "https://acme.com", host: "acme.com", name: "Acme" },
        fetchImpl,
        publicResolver,
      ),
    ).resolves.toMatchObject({
      sourceUrl: "https://acme.com/landing",
      title: "Acme Landing",
      h1: "Turn visitors into pipeline",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("parses a large modern homepage from its readable prefix instead of discarding it (#1530)", async () => {
    // Real Next.js/JS-framework homepages (e.g. vercel.com, stripe.com) inflate well past the byte cap,
    // but the <title>/<h1> live in the early markup. We must read the safe prefix and personalize from it —
    // not return null and dead-end the prospect at a 502.
    const bigHtml =
      "<!doctype html><title>Agentic Infrastructure - Vercel</title><h1>Ship with agents</h1>" +
      "<a>Start deploying</a>" +
      "<p>" +
      "x".repeat(900 * 1024) +
      "</p>";
    const fetchImpl = vi.fn<PublicWebFetch>(
      async () =>
        new Response(bigHtml, { status: 200, headers: { "content-type": "text/html" } }),
    );

    await expect(
      readSiteSnapshot(
        { url: "https://vercel.com", host: "vercel.com", name: "Vercel" },
        fetchImpl,
        publicResolver,
      ),
    ).resolves.toMatchObject({
      status: 200,
      title: "Agentic Infrastructure - Vercel",
      h1: "Ship with agents",
    });
  });

  it("returns a truthful deliverable snapshot when the public homepage serves an HTTP error", async () => {
    const fetchImpl = vi.fn<PublicWebFetch>(async () => {
      return new Response(
        "<!doctype html><title>Page not found | Wix.com</title><h1>This domain is not connected</h1>",
        {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    });

    await expect(
      readSiteSnapshot(
        { url: "https://getfoolish.com", host: "getfoolish.com", name: "Getfoolish" },
        fetchImpl,
        publicResolver,
      ),
    ).resolves.toMatchObject({
      sourceUrl: "https://getfoolish.com/",
      status: 404,
      title: "HTTP 404 from getfoolish.com",
      description: expect.stringContaining("buyers and crawlers are seeing an error"),
      keywords: expect.arrayContaining(["getfoolish"]),
    });
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
    expect(buildDeliverable(business, snapshot)).toEqual(
      buildDeliverable(deriveBusiness("acme.com")!, snapshot),
    );
  });

  it("uses the site reader and returns null when the site cannot be read", async () => {
    await expect(
      buildDeliverableForBusiness(business, async () => snapshot),
    ).resolves.toMatchObject({
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
