/**
 * Search Console service tests (#265) over in-memory fakes (no DB, no network). Proves the premortem
 * properties end-to-end:
 *  §4 submitSitemap has NO autonomous submit path — it can only park a #13 approval, and only when the
 *     feature flag is ON for the workspace and Google is connected; it never calls the provider.
 *  §2 executeApprovedSubmission marks `verified` ONLY when Search Console confirms it; the default dry-run
 *     provider yields an honest `submitted`/`failed` with no fabricated coverage.
 *  §6 a foreign URL in the request never reaches a submit (the plan drops it before the gate).
 */
import { describe, expect, it } from "vitest";
import { SearchConsoleService, type SearchConsoleApprovalGate } from "../../src/search-console/service.js";
import { DryRunSearchConsoleProvider, type SearchConsoleProvider } from "../../src/search-console/provider.js";
import { SEARCH_CONSOLE_DEFAULTS, type SearchConsoleCaps } from "../../src/search-console/caps.js";
import type {
  SearchConsoleSubmissionStore,
  SubmissionReceiptInput,
  SubmissionReceiptRow,
} from "../../src/db/repositories/search-console.js";

function makeStore(): SearchConsoleSubmissionStore & { rows: SubmissionReceiptRow[] } {
  const rows: SubmissionReceiptRow[] = [];
  let seq = 0;
  return {
    rows,
    async record(_ws, input: SubmissionReceiptInput) {
      const id = `rec-${++seq}`;
      rows.push({ id, createdAtMs: seq, ...input });
      return { id };
    },
    async latest() {
      return rows.length ? rows[rows.length - 1]! : null;
    },
    async latestVerifiedIndexedPages() {
      const verified = rows.filter((r) => r.accepted && r.indexedPages !== null);
      return verified.length ? verified[verified.length - 1]!.indexedPages : null;
    },
  };
}

let approvalSeq = 0;
const countingGate: SearchConsoleApprovalGate = {
  async submit() {
    return { id: `appr-${++approvalSeq}` };
  },
};

function service(
  over: {
    caps?: Partial<SearchConsoleCaps>;
    provider?: SearchConsoleProvider;
    connected?: boolean;
    siteUrl?: string;
    approvals?: SearchConsoleApprovalGate;
  } = {},
) {
  const store = makeStore();
  const caps: SearchConsoleCaps = { ...SEARCH_CONSOLE_DEFAULTS, ...over.caps };
  const svc = new SearchConsoleService({
    store,
    caps: () => caps,
    provider: () => over.provider ?? new DryRunSearchConsoleProvider(),
    siteUrl: () => over.siteUrl ?? "https://ipop.ai",
    searchConsoleConnected: async () => over.connected ?? true,
    approvals: over.approvals ?? countingGate,
    now: () => new Date(1_700_000_000_000),
  });
  return { svc, store };
}

const ENABLED = { autoSubmitEnabled: true, ownerWorkspaceId: null };

describe("SearchConsoleService.submitSitemap — gate (§4, no autonomous path)", () => {
  it("is disabled by default (flag OFF) and records nothing", async () => {
    const { svc, store } = service();
    const res = await svc.submitSitemap({ workspaceId: "ws1", requesterMemberId: "m1" });
    expect(res.status).toBe("disabled");
    expect(store.rows).toHaveLength(0);
  });

  it("is disabled for a non-owner workspace when an owner pin is set", async () => {
    const { svc } = service({ caps: { autoSubmitEnabled: true, ownerWorkspaceId: "ws-owner" } });
    const res = await svc.submitSitemap({ workspaceId: "ws-other", requesterMemberId: "m1" });
    expect(res.status).toBe("disabled");
  });

  it("returns not_connected (no live call) when Google Search Console is not connected", async () => {
    const { svc, store } = service({ caps: ENABLED, connected: false });
    const res = await svc.submitSitemap({ workspaceId: "ws1", requesterMemberId: "m1" });
    expect(res.status).toBe("not_connected");
    expect(store.rows[0]).toMatchObject({ status: "not_connected", approvalRequestId: null });
  });

  it("rejects a request whose site URL is not a valid https origin", async () => {
    const { svc, store } = service({ caps: ENABLED, siteUrl: "" });
    const res = await svc.submitSitemap({ workspaceId: "ws1", requesterMemberId: "m1" });
    expect(res.status).toBe("rejected");
    expect(store.rows[0]).toMatchObject({ status: "rejected" });
  });

  it("parks a #13 approval (the ONLY thing it can do) and records pending_approval", async () => {
    const { svc, store } = service({ caps: ENABLED, connected: true });
    const res = await svc.submitSitemap({
      workspaceId: "ws1",
      requesterMemberId: "m1",
      urls: ["https://ipop.ai/blog/new", "https://evil.com/x"], // foreign dropped before the gate (§6)
    });
    expect(res.status).toBe("pending_approval");
    if (res.status === "pending_approval") {
      expect(res.approvalRequestId).toMatch(/^appr-/);
      expect(res.plan.sitemapUrl).toBe("https://ipop.ai/sitemap.xml");
      expect(res.plan.indexingUrls).toEqual(["https://ipop.ai/blog/new"]); // foreign URL never reaches submit
    }
    expect(store.rows[0]).toMatchObject({
      status: "pending_approval",
      indexingRequested: 1,
      accepted: false,
    });
  });

  it("never calls the provider during submit (it cannot submit live)", async () => {
    let submitCalls = 0;
    const spyProvider: SearchConsoleProvider = {
      kind: "search_console",
      async submitSitemap() {
        submitCalls += 1;
        return { ok: true };
      },
      async requestIndexing() {
        return null;
      },
      async getSitemap() {
        return null;
      },
      async coverage() {
        return null;
      },
    };
    const { svc } = service({ caps: ENABLED, connected: true, provider: spyProvider });
    await svc.submitSitemap({ workspaceId: "ws1", requesterMemberId: "m1" });
    expect(submitCalls).toBe(0);
  });
});

describe("SearchConsoleService.executeApprovedSubmission — verify (§2)", () => {
  const plan = {
    siteUrl: "https://ipop.ai",
    sitemapUrl: "https://ipop.ai/sitemap.xml",
    indexingUrls: ["https://ipop.ai/blog/a", "https://ipop.ai/blog/b"],
  };

  it("with the dry-run provider records an honest 'failed' (nothing verified, no coverage)", async () => {
    const { svc, store } = service({ caps: ENABLED });
    const res = await svc.executeApprovedSubmission({ workspaceId: "ws1", approvalRequestId: "appr-1", plan });
    expect(res.status).toBe("failed"); // dry-run submit.ok === false, verification not accepted
    expect(res.verification.accepted).toBe(false);
    expect(res.indexedPages).toBeNull();
    expect(store.rows[0]).toMatchObject({ status: "failed", accepted: false, indexedPages: null });
  });

  it("marks 'verified' + records coverage ONLY when Search Console confirms it", async () => {
    const liveProvider: SearchConsoleProvider = {
      kind: "search_console",
      async submitSitemap() {
        return { ok: true };
      },
      async requestIndexing({ url }) {
        return { url, requested: true, externalId: `note-${url}` };
      },
      async getSitemap() {
        return { path: "https://ipop.ai/sitemap.xml", errors: 0, contents: [{ submitted: 12, indexed: 9 }] };
      },
      async coverage() {
        return { indexedPages: 9 };
      },
    };
    const { svc, store } = service({ caps: { ...ENABLED, provider: "search_console" }, provider: liveProvider });
    const res = await svc.executeApprovedSubmission({ workspaceId: "ws1", approvalRequestId: "appr-1", plan });
    expect(res.status).toBe("verified");
    expect(res.verification.accepted).toBe(true);
    expect(res.indexingRequested).toBe(2);
    expect(res.indexedPages).toBe(9);
    expect(store.rows[0]).toMatchObject({ status: "verified", accepted: true, indexedPages: 9 });
  });

  it("marks 'submitted' (not verified) when Google accepted the PUT but has not confirmed the sitemap", async () => {
    const pendingProvider: SearchConsoleProvider = {
      kind: "search_console",
      async submitSitemap() {
        return { ok: true };
      },
      async requestIndexing() {
        return null;
      },
      async getSitemap() {
        return { isPending: true }; // present? no path/lastSubmitted → not accepted yet
      },
      async coverage() {
        return null;
      },
    };
    const { svc } = service({ caps: { ...ENABLED, provider: "search_console" }, provider: pendingProvider });
    const res = await svc.executeApprovedSubmission({ workspaceId: "ws1", approvalRequestId: "appr-1", plan });
    expect(res.status).toBe("submitted");
    expect(res.verification.accepted).toBe(false);
  });
});

describe("SearchConsoleService.summary", () => {
  it("is connected only once a verified indexed-page reading exists", async () => {
    const liveProvider: SearchConsoleProvider = {
      kind: "search_console",
      async submitSitemap() {
        return { ok: true };
      },
      async requestIndexing() {
        return null;
      },
      async getSitemap() {
        return { path: "x", errors: 0 };
      },
      async coverage() {
        return { indexedPages: 14 };
      },
    };
    const { svc } = service({ caps: { ...ENABLED, provider: "search_console" }, provider: liveProvider });
    let sum = await svc.summary("ws1");
    expect(sum.connected).toBe(false);
    expect(sum.indexedPages).toBeNull();
    expect(sum.autoSubmitEnabled).toBe(true);

    await svc.executeApprovedSubmission({
      workspaceId: "ws1",
      approvalRequestId: "appr-1",
      plan: { siteUrl: "https://ipop.ai", sitemapUrl: "https://ipop.ai/sitemap.xml", indexingUrls: [] },
    });
    sum = await svc.summary("ws1");
    expect(sum.connected).toBe(true);
    expect(sum.indexedPages).toBe(14);
  });
});
