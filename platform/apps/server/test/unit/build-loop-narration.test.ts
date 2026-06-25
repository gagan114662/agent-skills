import { describe, expect, it } from "vitest";
import {
  createBuildInPublicNarrator,
  renderBuildInPublicNarration,
  type BuildInPublicSocialService,
} from "../../src/build-loop/narration.js";
import type { BuildRunRecord } from "../../src/build-loop/types.js";

const RUN: BuildRunRecord = {
  id: "run-1",
  workspaceId: "ws-1",
  issueRef: "github:gagan114662/agent-skills#1059",
  issueTitle: "build-in-public narration of real venture builds",
  priority: 5,
  dependsOn: null,
  agentOk: true,
  status: "merged",
  reviewRounds: 1,
  buildSessionId: "sess-1",
  prRef: "github:gagan114662/agent-skills#1200",
  prHeadBranch: "fix/1059",
  mergeRef: "merge-sha",
  escalationReason: null,
  targetChannelId: "chan-1",
  targetAgentMemberId: "agent-member-1",
  createdAt: new Date("2026-06-25T12:00:00.000Z"),
  updatedAt: new Date("2026-06-25T12:01:00.000Z"),
};

function fakeSocial(): BuildInPublicSocialService & {
  drafts: Array<{ body: string; networks: string[] }>;
  requests: Array<{ postId: string; requesterMemberId: string }>;
} {
  const drafts: Array<{ body: string; networks: string[] }> = [];
  const requests: Array<{ postId: string; requesterMemberId: string }> = [];
  return {
    drafts,
    requests,
    async draftPost(input) {
      drafts.push({ body: input.body, networks: input.networks });
      return {
        status: "drafted",
        post: {
          id: "post-1",
          workspaceId: input.workspaceId,
          body: input.body,
          networks: ["x", "linkedin"],
          scheduledAt: null,
          status: "draft",
          approvalRequestId: null,
          aggregatorRef: null,
          createdAt: "2026-06-25T12:02:00.000Z",
        },
        previews: [],
      };
    },
    async requestPublish(input) {
      requests.push({ postId: input.postId, requesterMemberId: input.requesterMemberId });
      return { status: "pending_approval", approvalRequestId: "approval-1", postId: input.postId };
    },
  };
}

describe("build-in-public narration (#1059)", () => {
  it("renders a public narration artifact with the Engine-1 badge", () => {
    const artifact = renderBuildInPublicNarration({
      workspaceId: "ws-1",
      run: RUN,
      mergeRef: "merge-sha",
    });

    expect(artifact.body).toContain("We shipped: build-in-public narration");
    expect(artifact.body).toContain("Issue: github:gagan114662/agent-skills#1059");
    expect(artifact.body).toContain("Engine 1 is doing its job");
    expect(artifact.body).toContain("Built with ipop:");
    expect(artifact.body).toContain("utm_campaign=build_in_public");
    expect(artifact.networks).toEqual(["x", "linkedin"]);
  });

  it("drafts and parks the narration behind the existing social approval gate", async () => {
    const social = fakeSocial();
    const narrator = createBuildInPublicNarrator(social);

    const result = await narrator.narrate({ workspaceId: "ws-1", run: RUN, mergeRef: "merge-sha" });

    expect(result.status).toBe("pending_approval");
    expect(social.drafts).toHaveLength(1);
    expect(social.drafts[0]!.networks).toEqual(["x", "linkedin"]);
    expect(social.drafts[0]!.body).toContain("Built with ipop:");
    expect(social.requests).toEqual([{ postId: "post-1", requesterMemberId: "agent-member-1" }]);
  });
});
