import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DryRunSiteReaderProvider,
  LiveSiteReaderProvider,
  type SiteReaderProvider,
} from "../../src/marketing/site-reader/provider.js";
import {
  shouldReadSiteContent,
  createSiteReader,
} from "../../src/marketing/site-reader/service.js";
import { composeSiteFactsBlock, type FetchedPage } from "../../src/marketing/site-reader/distill.js";
import type { HostResolver } from "../../src/security/public-web-url.js";

/**
 * #363 — the IO half of the public-site reader: provider (DryRun default + Live same-origin crawl) and
 * the service gate + cache. The Live crawl is exercised with a stubbed `fetch` so CI never hits the
 * network. Safety properties asserted directly: same-origin containment (SSRF), http(s)-only, graceful
 * skip on failure, and the default-OFF/owner-first gate.
 */

afterEach(() => vi.unstubAllGlobals());

/** Stub global fetch with a url→{status,html} map; an unmapped url throws (a network error). */
function stubFetch(pages: Record<string, { status: number; html: string }>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const hit = pages[url];
      if (!hit) throw new Error(`unmapped ${url}`);
      return { status: hit.status, text: async () => hit.html } as unknown as Response;
    }),
  );
}

const publicResolver: HostResolver = async () => [{ address: "93.184.216.34", family: 4 }];

function liveProvider(resolver: HostResolver = publicResolver): LiveSiteReaderProvider {
  return new LiveSiteReaderProvider(undefined, undefined, resolver);
}

describe("DryRunSiteReaderProvider (#363 default — reads nothing)", () => {
  it("returns an empty page set (no network, no fabricated facts)", async () => {
    const pages = await new DryRunSiteReaderProvider().fetchPages("https://ipop.ai");
    expect(pages).toEqual([]);
  });
});

describe("LiveSiteReaderProvider (#363 — same-origin read-only crawl)", () => {
  it("fetches the seed and same-origin links, dropping cross-origin ones (SSRF containment)", async () => {
    stubFetch({
      "https://ipop.ai/": {
        status: 200,
        html:
          '<html><head><title>ipop.ai</title></head><body>' +
          '<a href="/pricing">Pricing</a>' +
          '<a href="https://evil.com/steal">offsite</a>' +
          '<a href="mailto:x@y.com">mail</a>' +
          "</body></html>",
      },
      "https://ipop.ai/pricing": { status: 200, html: "<title>Pricing</title>" },
    });

    const pages = await liveProvider().fetchPages("https://ipop.ai/");
    const urls = pages.map((p) => p.url);
    expect(urls).toContain("https://ipop.ai/");
    expect(urls).toContain("https://ipop.ai/pricing");
    expect(urls.some((u) => u.includes("evil.com"))).toBe(false);
  });

  it("refuses a non-http(s) seed (returns nothing)", async () => {
    stubFetch({});
    const pages = await liveProvider().fetchPages("file:///etc/passwd");
    expect(pages).toEqual([]);
  });

  it("refuses private DNS answers before fetching a seed", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const privateResolver: HostResolver = async () => [{ address: "10.0.0.8", family: 4 }];

    const pages = await liveProvider(privateResolver).fetchPages("https://private.example/");

    expect(pages).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses hex, abbreviated, and non-standard-port numeric seeds before fetching", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const provider = liveProvider();

    await expect(provider.fetchPages("http://2130706433/")).resolves.toEqual([]);
    await expect(provider.fetchPages("http://0x7f000001/")).resolves.toEqual([]);
    await expect(provider.fetchPages("http://127.1/")).resolves.toEqual([]);
    await expect(provider.fetchPages("https://example.com:8443/")).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates redirect hops and blocks private redirect destinations", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return new Response(null, { status: 302, headers: { location: "http://private.example/admin" } });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const resolver: HostResolver = async (hostname) =>
      hostname === "private.example"
        ? [{ address: "169.254.169.254", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }];

    const pages = await liveProvider(resolver).fetchPages("https://ipop.ai/");

    expect(pages).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://ipop.ai/", expect.objectContaining({ redirect: "manual" }));
  });

  it("skips a page whose fetch throws, never failing the whole crawl", async () => {
    // Seed succeeds and links to /a (unmapped → throws); the crawl still returns the seed page.
    stubFetch({
      "https://ipop.ai/": { status: 200, html: '<title>Home</title><a href="/a">A</a>' },
    });
    const pages = await liveProvider().fetchPages("https://ipop.ai/");
    expect(pages.map((p) => p.url)).toEqual(["https://ipop.ai/"]);
  });
});

describe("shouldReadSiteContent gate (#363 default-OFF, owner-first)", () => {
  const ON = { injectWorkspaceContext: true, readSiteContent: true, ownerWorkspaceId: "ipop" };

  it("is OFF unless preamble injection, the read flag, and the owner workspace all line up", () => {
    expect(shouldReadSiteContent({}, "ipop")).toBe(false);
    expect(shouldReadSiteContent({ readSiteContent: true, ownerWorkspaceId: "ipop" }, "ipop")).toBe(false); // preamble off
    expect(shouldReadSiteContent({ injectWorkspaceContext: true, ownerWorkspaceId: "ipop" }, "ipop")).toBe(false); // read flag off
    expect(shouldReadSiteContent({ injectWorkspaceContext: true, readSiteContent: true }, "ipop")).toBe(false); // no owner named
    expect(shouldReadSiteContent(ON, "customer")).toBe(false); // not the owner workspace
  });

  it("is ON only for the designated owner workspace with both flags set", () => {
    expect(shouldReadSiteContent(ON, "ipop")).toBe(true);
  });
});

describe("createSiteReader cache (#363)", () => {
  it("caches within the TTL and re-crawls after it (provider called once, then twice)", async () => {
    const calls: string[] = [];
    let clock = 1_000;
    const provider: SiteReaderProvider = {
      kind: "fake",
      fetchPages: async (seed): Promise<FetchedPage[]> => {
        calls.push(seed);
        return [{ url: seed, status: 200, html: "<title>Home</title>" }];
      },
    };
    const reader = createSiteReader({ provider, ttlMs: 100, now: () => clock });

    await reader.read("https://ipop.ai/");
    await reader.read("https://ipop.ai/"); // within TTL → cached, no second call
    expect(calls).toHaveLength(1);

    clock += 200; // past TTL → re-crawl
    await reader.read("https://ipop.ai/");
    expect(calls).toHaveLength(2);
  });

  it("distills the crawled pages into a composable DATA block", async () => {
    const provider: SiteReaderProvider = {
      kind: "fake",
      fetchPages: async (): Promise<FetchedPage[]> => [
        { url: "https://ipop.ai/", status: 200, html: "<title>ipop.ai</title><h1>Marketing that runs itself</h1>" },
      ],
    };
    const reader = createSiteReader({ provider });
    const facts = await reader.read("https://ipop.ai/");
    const block = composeSiteFactsBlock(facts);
    expect(block).toContain("- Title: ipop.ai");
    expect(block).toContain("- Headings: Marketing that runs itself");
  });
});
