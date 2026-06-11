import { describe, it, expect, vi } from "vitest";
import { GitHubIssueProvider } from "../../src/integrations/issues/github.js";
import { IssueProviderError, parseIssueRef } from "../../src/integrations/issues/types.js";

/** Build a provider over a stubbed fetch so the test is network-free (#57 convention). */
function provider(fetchImpl: typeof fetch): GitHubIssueProvider {
  return new GitHubIssueProvider({ fetch: fetchImpl });
}

describe("GitHubIssueProvider.createIssue (#117, additive to #57)", () => {
  it("POSTs to the issues endpoint and returns the canonical ref", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ number: 321, state: "open", html_url: "https://gh/acme/web/issues/321" }), {
        status: 201,
      }),
    ) as unknown as typeof fetch;

    const res = await provider(fetchImpl).createIssue(
      { owner: "acme", repo: "web" },
      "tok",
      { title: "boom", body: "redacted body", labels: ["flywheel"] },
    );

    expect(res).toEqual({
      number: 321,
      ref: "github:acme/web#321",
      state: "open",
      url: "https://gh/acme/web/issues/321",
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/acme/web/issues");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toMatchObject({ title: "boom", body: "redacted body", labels: ["flywheel"] });
  });

  it("throws a content-free error on a non-2xx (no token/body leak)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await expect(
      provider(fetchImpl).createIssue({ owner: "a", repo: "b" }, "tok", { title: "t", body: "b" }),
    ).rejects.toBeInstanceOf(IssueProviderError);
  });
});

describe("GitHubIssueProvider.reopenIssue (#117 — the #106 outcome verifier)", () => {
  it("PATCHes state=open and returns the resulting state", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ state: "open" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const res = await provider(fetchImpl).reopenIssue(parseIssueRef("github:acme/web#7"), "tok");
    expect(res.state).toBe("open");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/acme/web/issues/7");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ state: "open" });
  });
});

describe("GitHubIssueProvider.listOpenIssuesByLabel (#108 — the uptime dedupe read)", () => {
  it("GETs open issues filtered by label and returns {number, body} rows", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify([
          { number: 12, body: "down <!-- uptime-monitor:api -->" },
          { number: 13, body: "down <!-- uptime-monitor:web -->" },
        ]),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const rows = await provider(fetchImpl).listOpenIssuesByLabel(
      { owner: "acme", repo: "web" },
      "tok",
      "uptime-alert",
    );

    expect(rows).toEqual([
      { number: 12, body: "down <!-- uptime-monitor:api -->" },
      { number: 13, body: "down <!-- uptime-monitor:web -->" },
    ]);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/repos/acme/web/issues?");
    expect(url).toContain("state=open");
    expect(url).toContain("labels=uptime-alert");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("throws a content-free error on a non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(
      provider(fetchImpl).listOpenIssuesByLabel({ owner: "a", repo: "b" }, "tok", "uptime-alert"),
    ).rejects.toBeInstanceOf(IssueProviderError);
  });
});

describe("GitHubIssueProvider.closeIssue (#108 — the uptime recovery write)", () => {
  it("PATCHes state=closed and returns the resulting state", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ state: "closed" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const res = await provider(fetchImpl).closeIssue(parseIssueRef("github:acme/web#7"), "tok");
    expect(res.state).toBe("closed");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/acme/web/issues/7");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ state: "closed" });
  });
});
