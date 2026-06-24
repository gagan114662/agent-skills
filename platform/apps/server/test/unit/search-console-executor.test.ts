import { describe, expect, it } from "vitest";
import { ActionExecutionError } from "../../src/approvals/executor.js";
import { SEARCH_CONSOLE_SUBMIT_ACTION } from "../../src/approvals/policy.js";
import { buildDefaultRegistry } from "../../src/approvals/runtime.js";
import type { SearchConsoleService } from "../../src/search-console/service.js";
import type { SitemapSubmissionPlan } from "../../src/search-console/types.js";

function registryWithSearchConsole(fake: Pick<SearchConsoleService, "executeApprovedSubmission">) {
  return buildDefaultRegistry(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fake as SearchConsoleService,
  );
}

const ctx = {
  workspaceId: "ws-1",
  requesterMemberId: "mem-1",
  requestId: "appr-1",
  log: console as never,
};

describe("searchconsole.submit executor (#880)", () => {
  it("calls executeApprovedSubmission with the approved sitemap payload", async () => {
    const calls: Array<{
      workspaceId: string;
      approvalRequestId: string;
      plan: SitemapSubmissionPlan;
    }> = [];
    const registry = registryWithSearchConsole({
      async executeApprovedSubmission(input) {
        calls.push(input);
        return {
          status: "submitted",
          verification: {
            sitemapUrl: input.plan.sitemapUrl,
            accepted: false,
            isPending: true,
            errors: 0,
            warnings: 0,
            submittedUrls: 0,
            indexedUrls: 0,
            lastDownloadedMs: null,
          },
          indexingRequested: input.plan.indexingUrls.length,
          indexedPages: null,
        };
      },
    });
    const exec = registry.get(SEARCH_CONSOLE_SUBMIT_ACTION)!;

    const result = await exec.execute(
      {
        source: "search_console",
        action: "submit_sitemap",
        siteUrl: "https://ipop.ai",
        sitemapUrl: "https://ipop.ai/sitemap.xml",
        urls: ["https://ipop.ai/blog/a"],
      },
      ctx,
    );

    expect(calls).toEqual([
      {
        workspaceId: "ws-1",
        approvalRequestId: "appr-1",
        plan: {
          siteUrl: "https://ipop.ai",
          sitemapUrl: "https://ipop.ai/sitemap.xml",
          indexingUrls: ["https://ipop.ai/blog/a"],
        },
      },
    ]);
    expect(result).toMatchObject({
      recorded: true,
      executed: true,
      status: "submitted",
      indexingRequested: 1,
    });
  });

  it("fails clearly when the approval payload cannot form a sitemap plan", async () => {
    const registry = registryWithSearchConsole({
      async executeApprovedSubmission() {
        throw new Error("should not execute");
      },
    });
    const exec = registry.get(SEARCH_CONSOLE_SUBMIT_ACTION)!;

    await expect(exec.execute({ sitemapUrl: "https://ipop.ai/sitemap.xml" }, ctx)).rejects.toThrow(
      ActionExecutionError,
    );
  });
});
