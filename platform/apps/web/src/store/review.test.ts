import { beforeEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "./store.js";
import { makeFakeDeps } from "../test/utils.js";
import type { AgentSessionSummary, ServerEvent } from "../api/types.js";

/**
 * The #51 review slice: loading a channel's sessions + PRs, selecting a session to load its diff +
 * comments, adding/delivering comments (the round trip), opening a PR, refreshing checks, and
 * reacting to the `pull_request` / `review_comment` realtime events.
 */
const session: AgentSessionSummary = {
  id: "s1",
  channelId: "c1",
  agentMemberId: "ag1",
  status: "completed",
  result: null,
  branch: "agent/s1",
  baseBranch: "main",
  headSha: "abc",
  createdAt: "2026-06-09T00:00:00.000Z",
};

function setup(): { store: Store; rt: ReturnType<typeof makeFakeDeps>["rt"] } {
  const { deps, rt } = makeFakeDeps({ sessions: [session] });
  return { store: createStore(deps), rt };
}

describe("review slice", () => {
  let store: Store;
  let rt: ReturnType<typeof makeFakeDeps>["rt"];

  beforeEach(async () => {
    ({ store, rt } = setup());
    await store.bootstrap(); // selects channel c1
  });

  it("loads the channel's sessions and auto-selects the first with its diff", async () => {
    await store.loadReview();
    const s = store.getState().review;
    expect(s.sessions.map((x) => x.id)).toEqual(["s1"]);
    expect(s.activeSessionId).toBe("s1");
    expect(s.diff?.branch).toBe("agent/s1");
    expect(s.diff?.mode).toBe("cumulative");
  });

  it("switches diff mode and reloads", async () => {
    await store.loadReview();
    await store.setDiffMode("turn");
    expect(store.getState().review.diffMode).toBe("turn");
    expect(store.getState().review.diff?.mode).toBe("turn");
  });

  it("adds a review comment to the active session", async () => {
    await store.loadReview();
    await store.addReviewComment({ filePath: "src/a.ts", body: "rename this" });
    expect(store.getState().review.comments).toHaveLength(1);
    expect(store.getState().review.comments[0]!.filePath).toBe("src/a.ts");
  });

  it("delivers comments and returns the delivered count", async () => {
    await store.loadReview();
    const n = await store.deliverComments();
    expect(n).toBe(1);
  });

  it("creates a pull request and lists it", async () => {
    await store.loadReview();
    await store.createPullRequest({ title: "Add feature" });
    const prs = store.getState().review.pullRequests;
    expect(prs).toHaveLength(1);
    expect(prs[0]!.title).toBe("Add feature");
  });

  it("upserts a pull_request realtime event into the slice", async () => {
    await store.loadReview();
    const event: ServerEvent = {
      type: "pull_request",
      pullRequest: {
        id: "pr9",
        workspaceId: "w1",
        channelId: "c1",
        sessionId: "s1",
        number: 9,
        url: "https://github.com/o/r/pull/9",
        title: "Live PR",
        body: null,
        draft: false,
        state: "open",
        checksStatus: "pending",
        baseBranch: "main",
        headBranch: "agent/s1",
        provider: "gh",
        createdByMemberId: "me1",
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
      },
    };
    rt.fire(event);
    expect(store.getState().review.pullRequests.find((p) => p.id === "pr9")?.number).toBe(9);
  });

  it("appends a review_comment event for the active session only", async () => {
    await store.loadReview();
    const base = store.getState().review.comments.length;
    rt.fire({
      type: "review_comment",
      comment: {
        id: "rcLive",
        workspaceId: "w1",
        channelId: "c1",
        sessionId: "s1",
        pullRequestId: null,
        filePath: "src/b.ts",
        lineStart: 5,
        lineEnd: 5,
        body: "live",
        authorMemberId: "m2",
        deliveredToSessionId: null,
        createdAt: "2026-06-09T00:00:00.000Z",
      },
    });
    expect(store.getState().review.comments).toHaveLength(base + 1);

    // A comment for a different session is ignored.
    rt.fire({
      type: "review_comment",
      comment: {
        id: "rcOther",
        workspaceId: "w1",
        channelId: "c1",
        sessionId: "other",
        pullRequestId: null,
        filePath: "src/c.ts",
        lineStart: null,
        lineEnd: null,
        body: "nope",
        authorMemberId: "m2",
        deliveredToSessionId: null,
        createdAt: "2026-06-09T00:00:00.000Z",
      },
    });
    expect(store.getState().review.comments.find((c) => c.id === "rcOther")).toBeUndefined();
  });
});
