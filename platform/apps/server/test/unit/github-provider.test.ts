import { describe, it, expect } from "vitest";
import { NoneGitHubProvider, GitHubUnavailableError } from "../../src/github/none.js";
import { rollupChecks } from "../../src/github/checks.js";
import { createGitHubProvider } from "../../src/github/factory.js";

/**
 * The GitHub seam (#51) mirrors #25's SandboxProvider discipline: a real adapter behind config and a
 * `none` default that has no credentials — so CI/tests never call GitHub. The PR route surfaces the
 * `none` provider as a 501. The checks rollup is pure and unit-tested here.
 */
describe("NoneGitHubProvider", () => {
  const provider = new NoneGitHubProvider();

  it("is the 'none' kind", () => {
    expect(provider.kind).toBe("none");
  });

  it("refuses to create a PR with a typed error (route maps to 501)", async () => {
    await expect(
      provider.createPullRequest({
        repoRoot: "/tmp/r",
        baseBranch: "main",
        headBranch: "agent/x",
        title: "t",
        body: "b",
        draft: false,
      }),
    ).rejects.toBeInstanceOf(GitHubUnavailableError);
  });

  it("refuses checks + logs with the typed error", async () => {
    await expect(provider.getChecks({ repoRoot: "/tmp/r", headBranch: "agent/x" })).rejects.toBeInstanceOf(
      GitHubUnavailableError,
    );
    await expect(
      provider.getFailingLogs({ repoRoot: "/tmp/r", headBranch: "agent/x" }),
    ).rejects.toBeInstanceOf(GitHubUnavailableError);
  });
});

describe("createGitHubProvider", () => {
  it("defaults to the none provider", () => {
    expect(createGitHubProvider({}).kind).toBe("none");
    expect(createGitHubProvider({ GITHUB_PROVIDER: "" }).kind).toBe("none");
  });

  it("selects the gh adapter when configured", () => {
    expect(createGitHubProvider({ GITHUB_PROVIDER: "gh" }).kind).toBe("gh");
  });
});

describe("rollupChecks", () => {
  it("is success only when every run completed successfully", () => {
    expect(
      rollupChecks([
        { name: "a", status: "completed", conclusion: "success", detailsUrl: null },
        { name: "b", status: "completed", conclusion: "skipped", detailsUrl: null },
      ]),
    ).toBe("success");
  });

  it("is failure when any run failed", () => {
    expect(
      rollupChecks([
        { name: "a", status: "completed", conclusion: "success", detailsUrl: null },
        { name: "b", status: "completed", conclusion: "failure", detailsUrl: null },
      ]),
    ).toBe("failure");
  });

  it("is pending while any run is not yet completed", () => {
    expect(
      rollupChecks([
        { name: "a", status: "in_progress", conclusion: null, detailsUrl: null },
      ]),
    ).toBe("pending");
  });

  it("is unknown with no runs", () => {
    expect(rollupChecks([])).toBe("unknown");
  });
});
