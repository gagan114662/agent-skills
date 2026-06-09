import { describe, it, expect } from "vitest";
import type { PullRequestDto, ReviewCommentDto } from "@reload/shared";
import { encodeEvent, type ServerEvent } from "../../src/realtime/protocol.js";

/**
 * The #51 ServerEvent variants ride the existing channel fan-out (`rt:channel:<id>`). This pins their
 * shape so the web client's event switch and the encoder stay in sync.
 */
describe("git/review server events", () => {
  const pr: PullRequestDto = {
    id: "pr1",
    workspaceId: "w1",
    channelId: "c1",
    sessionId: "s1",
    number: 7,
    url: "https://github.com/o/r/pull/7",
    title: "Add feature",
    body: null,
    draft: false,
    state: "open",
    checksStatus: "pending",
    baseBranch: "main",
    headBranch: "agent/s1",
    provider: "gh",
    createdByMemberId: "m1",
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
  };

  it("encodes a pull_request event round-trip", () => {
    const event: ServerEvent = { type: "pull_request", pullRequest: pr };
    const decoded = JSON.parse(encodeEvent(event)) as ServerEvent;
    expect(decoded.type).toBe("pull_request");
    if (decoded.type === "pull_request") {
      expect(decoded.pullRequest.number).toBe(7);
      expect(decoded.pullRequest.checksStatus).toBe("pending");
    }
  });

  it("encodes a review_comment event round-trip", () => {
    const comment: ReviewCommentDto = {
      id: "rc1",
      workspaceId: "w1",
      channelId: "c1",
      sessionId: "s1",
      pullRequestId: null,
      filePath: "src/a.ts",
      lineStart: 10,
      lineEnd: 12,
      body: "rename this",
      authorMemberId: "m1",
      deliveredToSessionId: null,
      createdAt: "2026-06-09T00:00:00.000Z",
    };
    const event: ServerEvent = { type: "review_comment", comment };
    const decoded = JSON.parse(encodeEvent(event)) as ServerEvent;
    expect(decoded.type).toBe("review_comment");
    if (decoded.type === "review_comment") {
      expect(decoded.comment.filePath).toBe("src/a.ts");
      expect(decoded.comment.lineEnd).toBe(12);
    }
  });
});
