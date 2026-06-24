import { describe, expect, it, vi } from "vitest";
import {
  parseIssueRef,
  buildIssueTask,
  IssueRefError,
  type IssueContext,
} from "../../src/integrations/issues/types.js";
import { GitHubIssueProvider } from "../../src/integrations/issues/github.js";
import { LinearIssueProvider } from "../../src/integrations/issues/linear.js";
import { defaultIssueProviders, resolveIssueProvider } from "../../src/integrations/issues/registry.js";

describe("parseIssueRef (#57)", () => {
  it("parses an explicit github ref", () => {
    const ref = parseIssueRef("github:acme/web#42");
    expect(ref).toMatchObject({ source: "github", owner: "acme", repo: "web", number: 42 });
  });

  it("parses a bare owner/repo#n as github", () => {
    const ref = parseIssueRef("acme/web-app#7");
    expect(ref).toMatchObject({ source: "github", owner: "acme", repo: "web-app", number: 7 });
  });

  it("parses a linear ref into team + number + key", () => {
    const ref = parseIssueRef("linear:ENG-123");
    expect(ref).toMatchObject({ source: "linear", team: "ENG", number: 123, key: "ENG-123" });
  });

  it("rejects garbage and ambiguous refs", () => {
    expect(() => parseIssueRef("")).toThrow(IssueRefError);
    expect(() => parseIssueRef("just-some-text")).toThrow(IssueRefError);
    expect(() => parseIssueRef("acme/web")).toThrow(IssueRefError); // no issue number
    expect(() => parseIssueRef("github:acme#1")).toThrow(IssueRefError); // no repo
    expect(() => parseIssueRef("linear:nope")).toThrow(IssueRefError);
  });
});

describe("buildIssueTask (#57)", () => {
  const ctx: IssueContext = {
    source: "github",
    ref: "github:acme/web#42",
    id: "42",
    title: "Login fails with special characters",
    body: "Steps:\n1. enter p@ss\n2. boom",
    url: "https://github.com/acme/web/issues/42",
    state: "open",
    labels: ["bug", "auth"],
    author: "octocat",
  };

  it("renders title, url, body, and labels into the prompt", () => {
    const task = buildIssueTask(ctx);
    expect(task).toContain("Login fails with special characters");
    expect(task).toContain("https://github.com/acme/web/issues/42");
    expect(task).toContain("enter p@ss");
    expect(task).toContain("bug");
    expect(task).toContain("auth");
  });

  it("appends optional instructions", () => {
    const task = buildIssueTask(ctx, "Only touch the auth module.");
    expect(task).toContain("Only touch the auth module.");
  });

  it("truncates an over-long body deterministically", () => {
    const big = { ...ctx, body: "x".repeat(10_000) };
    const task = buildIssueTask(big);
    expect(task.length).toBeLessThan(6_000);
    expect(task).toContain("…[truncated]");
  });
});

describe("GitHubIssueProvider (#57)", () => {
  function fakeFetch(status: number, json: unknown): typeof fetch {
    return vi.fn(async () =>
      new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
  }

  it("fetches an issue and maps it to IssueContext, sending the bearer token", async () => {
    const f = fakeFetch(200, {
      number: 42,
      title: "Bug",
      body: "broken",
      html_url: "https://github.com/acme/web/issues/42",
      state: "open",
      labels: [{ name: "bug" }, "p1"],
      user: { login: "octocat" },
    });
    const provider = new GitHubIssueProvider({ fetch: f });
    const ref = parseIssueRef("github:acme/web#42");
    const ctx = await provider.fetchIssue(ref, "ghp_secrettoken");

    expect(ctx).toMatchObject({
      source: "github",
      title: "Bug",
      body: "broken",
      url: "https://github.com/acme/web/issues/42",
      state: "open",
      author: "octocat",
    });
    expect(ctx.labels).toEqual(["bug", "p1"]);

    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("/repos/acme/web/issues/42");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ghp_secrettoken");
  });

  it("throws IssueProviderError on non-2xx without leaking the token", async () => {
    const provider = new GitHubIssueProvider({ fetch: fakeFetch(404, { message: "Not Found" }) });
    const ref = parseIssueRef("github:acme/web#99");
    await expect(provider.fetchIssue(ref, "ghp_secrettoken")).rejects.toMatchObject({
      name: "IssueProviderError",
    });
    await provider.fetchIssue(ref, "ghp_secrettoken").catch((e: Error) => {
      expect(e.message).not.toContain("ghp_secrettoken");
    });
  });

  it("posts a comment to the issue comments endpoint", async () => {
    const f = fakeFetch(201, { html_url: "https://github.com/acme/web/issues/42#issuecomment-1" });
    const provider = new GitHubIssueProvider({ fetch: f });
    const ref = parseIssueRef("github:acme/web#42");
    const res = await provider.postComment(ref, "ghp_x", "hello");
    expect(res.url).toContain("#issuecomment-1");
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("/repos/acme/web/issues/42/comments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ body: "hello" });
  });
});

describe("LinearIssueProvider (#57)", () => {
  it("queries by team key + number and maps the first node", async () => {
    const f = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "uuid-1",
                  identifier: "ENG-123",
                  title: "Linear bug",
                  description: "desc",
                  url: "https://linear.app/acme/issue/ENG-123",
                  state: { name: "Todo" },
                  labels: { nodes: [{ name: "frontend" }] },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const provider = new LinearIssueProvider({ fetch: f });
    const ctx = await provider.fetchIssue(parseIssueRef("linear:ENG-123"), "lin_api_key");
    expect(ctx).toMatchObject({
      source: "linear",
      title: "Linear bug",
      body: "desc",
      url: "https://linear.app/acme/issue/ENG-123",
      state: "Todo",
    });
    expect(ctx.labels).toEqual(["frontend"]);

    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe("lin_api_key");
    const body = JSON.parse(init.body as string);
    expect(body.variables).toMatchObject({ team: "ENG", number: 123 });
  });

  it("does not crash when Linear returns a null commentCreate payload", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { issues: { nodes: [{ id: "uuid-1", identifier: "ENG-123" }] } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { commentCreate: null } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof fetch;

    const provider = new LinearIssueProvider({ fetch: f });
    await expect(provider.postComment(parseIssueRef("linear:ENG-123"), "lin_api_key", "hello")).resolves.toEqual({
      url: "",
    });
  });
});

describe("issue provider registry (#57)", () => {
  it("resolves a provider by ref source", () => {
    const providers = defaultIssueProviders();
    expect(resolveIssueProvider(parseIssueRef("github:a/b#1"), providers).source).toBe("github");
    expect(resolveIssueProvider(parseIssueRef("linear:ENG-1"), providers).source).toBe("linear");
  });
});
