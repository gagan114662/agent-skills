import { appendBadge, buildAttributionBadge } from "../attribution/badge.js";
import type { SocialNetwork } from "../social/decide.js";
import type { DraftPostResult, RequestPublishResult } from "../social/service.js";
import type { BuildRunRecord } from "./types.js";

const BUILD_IN_PUBLIC_NETWORKS: readonly SocialNetwork[] = ["x", "linkedin"];

export interface BuildInPublicNarrationInput {
  workspaceId: string;
  run: BuildRunRecord;
  mergeRef: string;
}

export interface BuildInPublicNarrationArtifact {
  body: string;
  networks: readonly SocialNetwork[];
}

export type BuildInPublicNarrationResult =
  | {
      status: "pending_approval";
      postId: string;
      approvalRequestId: string;
      artifact: BuildInPublicNarrationArtifact;
    }
  | {
      status: "drafted";
      postId: string;
      artifact: BuildInPublicNarrationArtifact;
      reason: "missing_requester";
    }
  | { status: "disabled"; artifact: BuildInPublicNarrationArtifact }
  | { status: "rejected"; artifact: BuildInPublicNarrationArtifact; reason: string }
  | { status: "not_found"; artifact: BuildInPublicNarrationArtifact; postId: string };

export interface BuildInPublicSocialService {
  draftPost(input: {
    workspaceId: string;
    body: string;
    networks: string[];
    scheduledAt?: string | null;
  }): Promise<DraftPostResult>;
  requestPublish(input: {
    workspaceId: string;
    postId: string;
    requesterMemberId: string;
  }): Promise<RequestPublishResult>;
}

export interface BuildPublicNarrator {
  narrate(input: BuildInPublicNarrationInput): Promise<BuildInPublicNarrationResult>;
}

export function renderBuildInPublicNarration(
  input: BuildInPublicNarrationInput,
): BuildInPublicNarrationArtifact {
  const badge = buildAttributionBadge({
    workspaceId: input.workspaceId,
    artifactId: `build:${input.run.issueRef}:${input.mergeRef}`,
    channel: "build_in_public",
    format: "text",
    utmSource: "engine1",
  });
  const prLine = input.run.prRef ? `PR: ${input.run.prRef}` : "PR: internal build-loop merge";
  const body = [
    `We shipped: ${input.run.issueTitle}`,
    "",
    `Issue: ${input.run.issueRef}`,
    prLine,
    `Merge: ${input.mergeRef}`,
    "",
    "Engine 1 is doing its job: real build, public receipt, compounding distribution.",
  ].join("\n");

  return {
    body: appendBadge(body, badge, "text"),
    networks: BUILD_IN_PUBLIC_NETWORKS,
  };
}

export function createBuildInPublicNarrator(
  social: BuildInPublicSocialService,
): BuildPublicNarrator {
  return {
    async narrate(input) {
      const artifact = renderBuildInPublicNarration(input);
      const draft = await social.draftPost({
        workspaceId: input.workspaceId,
        body: artifact.body,
        networks: [...artifact.networks],
        scheduledAt: null,
      });

      if (draft.status === "disabled") return { status: "disabled", artifact };
      if (draft.status === "rejected") return { status: "rejected", artifact, reason: draft.reason };

      const requesterMemberId = input.run.targetAgentMemberId;
      if (!requesterMemberId) {
        return {
          status: "drafted",
          postId: draft.post.id,
          artifact,
          reason: "missing_requester",
        };
      }

      const request = await social.requestPublish({
        workspaceId: input.workspaceId,
        postId: draft.post.id,
        requesterMemberId,
      });
      if (request.status === "pending_approval") {
        return {
          status: "pending_approval",
          postId: request.postId,
          approvalRequestId: request.approvalRequestId,
          artifact,
        };
      }
      if (request.status === "disabled") return { status: "disabled", artifact };
      if (request.status === "not_found") return { status: "not_found", artifact, postId: draft.post.id };
      return { status: "rejected", artifact, reason: request.reason };
    },
  };
}
