import type { FastifyBaseLogger } from "fastify";
import type { Identity } from "../auth/identity.js";
import { addChannelMember, getChannel, type Channel } from "../db/repositories/channels.js";
import { findServiceCredentialOwnerBySecretValue, type ServiceCredentialDestinationOwner } from "../db/repositories/external-credentials.js";
import {
  getExternalRoomMessageReceipt,
  recordExternalRoomMessageReceipt,
  type ExternalRoomMessageProvider,
} from "../db/repositories/external-room-message-receipts.js";
import { getWorkspaceOwnerMemberId } from "../db/repositories/members.js";
import { postMessage } from "../db/repositories/messages.js";
import { grantCapability } from "../db/repositories/permissions.js";
import { newId } from "../db/id.js";
import { seedDepartmentForWorkspace } from "../marketing/default.js";
import type { SessionManager } from "../runtime/manager.js";
import type { TeamCoordinator, Subtask } from "../team/coordinator.js";
import type { CodexSubscriptionStatus, CodexSubscriptionStatusProvider } from "../routes/team.js";
import { publicAppOrigin } from "../product-origins.js";
import { deliverPostedMessage } from "./delivery.js";

export interface InboundTeamLaunchService {
  start(input: InboundTeamLaunchInput): Promise<InboundTeamLaunchResult>;
}

export interface InboundTeamLaunchInput {
  provider: ExternalRoomMessageProvider;
  serviceKey: string;
  destinationEnvKey: string;
  providerLabel: string;
  providerConversationId: string;
  providerMessageId: string | null;
  text: string;
  log: FastifyBaseLogger;
}

export type InboundTeamLaunchResult =
  | {
      status: "not_connected";
      replyText: string;
    }
  | {
      status: "duplicate";
      workspaceId: string;
      channelId: string;
      messageId: string;
      replyText: string;
    }
  | {
      status: "blocked_auth";
      workspaceId: string;
      channelId: string;
      messageId: string;
      codexStatus: CodexSubscriptionStatus;
      replyText: string;
    }
  | {
      status: "launched";
      workspaceId: string;
      channelId: string;
      messageId: string;
      teamRunId: string;
      subtaskCount: number;
      replyText: string;
    };

export interface InboundTeamLaunchOptions {
  sessionManager: SessionManager;
  coordinator: TeamCoordinator;
  codexSubscription: CodexSubscriptionStatusProvider;
  appBaseUrl?: string;
}

const ROOM_CHANNEL_NAME = "general";
const LAUNCH_HANDLES = ["scout", "quill", "lens", "echo", "bid"] as const;

const LANE_BY_HANDLE: Record<(typeof LAUNCH_HANDLES)[number], string> = {
  scout: "site and market audit",
  quill: "positioning and copy",
  lens: "taste, proof, and rubric scoring",
  echo: "social launch",
  bid: "paid acquisition plan",
};

const PHASE_BY_HANDLE: Record<(typeof LAUNCH_HANDLES)[number], number> = {
  scout: 1,
  quill: 2,
  lens: 3,
  echo: 4,
  bid: 4,
};

function roomUrl(appBaseUrl?: string): string {
  const base = appBaseUrl?.trim() || publicAppOrigin();
  return new URL("/everyday", base).toString();
}

function snippet(text: string, max = 160): string {
  const value = text.replace(/\s+/g, " ").trim();
  if (value.length <= max) return value;
  return value.slice(0, max - 1).trimEnd() + "...";
}

function displayHandle(handle: string): string {
  return handle.slice(0, 1).toUpperCase() + handle.slice(1);
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return names.join(" and ");
  return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
}

function connectionHelp(providerName: string, appUrl: string): string {
  if (providerName.toLowerCase() === "telegram") {
    return (
      "I do not know this Telegram chat yet. Open " +
      appUrl +
      ", tap Connect Telegram, press Start in the bot, then send this brief again."
    );
  }
  return (
    "I do not know this " +
    providerName +
    " room yet. Open " +
    appUrl +
    ", connect " +
    providerName +
    ", then send the brief again."
  );
}

function buildSubtask(handle: (typeof LAUNCH_HANDLES)[number], agentMemberId: string, objective: string): Subtask {
  const title = displayHandle(handle);
  const lane = LANE_BY_HANDLE[handle];
  return {
    subtaskId: newId(),
    agentMemberId,
    branch: "messaging-" + handle + "-" + newId().slice(0, 8),
    phase: PHASE_BY_HANDLE[handle],
    ...(handle === "scout" ? { producesArtifacts: ["scout_research" as const] } : {}),
    ...(handle === "quill" ? { producesArtifacts: ["draft_set" as const] } : {}),
    ...(handle === "lens" ? { producesArtifacts: ["lens_review" as const] } : {}),
    ...(handle === "quill"
      ? { requiresArtifacts: ["scout_research" as const] }
      : {}),
    ...(handle === "lens"
      ? { requiresArtifacts: ["scout_research" as const, "draft_set" as const] }
      : {}),
    ...(handle === "echo" || handle === "bid"
      ? { requiresArtifacts: ["scout_research" as const, "draft_set" as const, "lens_review" as const] }
      : {}),
    preferredHarness: "codex",
    task:
      "You are " +
      title +
      " in ipop's live marketing room. Work on the owner's current growth goal: " +
      objective +
      ". Your lane is " +
      lane +
      ".\n\n" +
      "The owner started this from a messaging channel. Read the brief, work in the room, leave concrete receipts, " +
      "and keep anything that sends, posts, publishes, or spends behind human approval.\n\n" +
      (handle === "scout"
        ? "Before this lane is done, produce the required scout_research artifact with siteSummary, ICP, positioning, proof points, competitors, tone notes, and source URLs.\n\n"
        : handle === "quill"
          ? "Use the validated scout_research artifact injected by the coordinator; produce the required draft_set artifact with channel-native formats that pass validation, and cite proofPoints or sourceUrls in every draft.\n\n"
          : handle === "lens"
            ? "Use the validated scout_research and draft_set artifacts injected by the coordinator; score every draft with the six-part rubric, revise any draft below threshold once, and produce the required lens_review artifact. Do not send, post, publish, or spend.\n\n"
            : "Use the validated scout_research, draft_set, and lens_review artifacts injected by the coordinator; cite artifact proofPoints, sourceUrls, and Lens scores in any draft or recommendation.\n\n") +
      "Owner brief: " +
      objective,
  };
}

async function connectedOwner(input: InboundTeamLaunchInput): Promise<ServiceCredentialDestinationOwner | null> {
  return findServiceCredentialOwnerBySecretValue({
    serviceKey: input.serviceKey,
    envKey: input.destinationEnvKey,
    value: input.providerConversationId,
  });
}

function identityFor(owner: ServiceCredentialDestinationOwner, memberId: string, providerLabel: string): Identity {
  return {
    workspaceId: owner.workspaceId,
    memberId,
    kind: "human",
    displayName: providerLabel,
  };
}

async function requireRoomChannel(channelId: string): Promise<Channel> {
  const channel = await getChannel(channelId);
  if (!channel || channel.isArchived) throw new Error("inbound marketing room channel is not available");
  return channel;
}

export function createInboundTeamLaunchService(options: InboundTeamLaunchOptions): InboundTeamLaunchService {
  const appUrl = roomUrl(options.appBaseUrl);

  return {
    async start(input) {
      const providerName = input.providerLabel;
      if (input.providerMessageId) {
        const existing = await getExternalRoomMessageReceipt({
          provider: input.provider,
          providerConversationId: input.providerConversationId,
          providerMessageId: input.providerMessageId,
        });
        if (existing) {
          return {
            status: "duplicate",
            workspaceId: existing.workspaceId,
            channelId: existing.channelId,
            messageId: existing.messageId,
            replyText:
              "Already on it. I found the same room message again, so I did not start a duplicate run. " +
              "Open the room: " +
              appUrl,
          };
        }
      }

      const owner = await connectedOwner(input);
      if (!owner) {
        return {
          status: "not_connected",
          replyText: connectionHelp(providerName, appUrl),
        };
      }

      const createdByMemberId = owner.connectedByMemberId ?? (await getWorkspaceOwnerMemberId(owner.workspaceId));
      if (!createdByMemberId) {
        return {
          status: "not_connected",
          replyText:
            "I found the " +
            providerName +
            " connection, but there is no human owner member to start the room. Open " +
            appUrl +
            " and reconnect " +
            providerName +
            ".",
        };
      }

      const seeded = await seedDepartmentForWorkspace(options.sessionManager, {
        workspaceId: owner.workspaceId,
        createdByMemberId,
        welcomeTasks: false,
      });
      const general = seeded.channels.find((channel) => channel.name === ROOM_CHANNEL_NAME);
      if (!general) throw new Error("marketing seed did not create the general room");
      const channel = await requireRoomChannel(general.id);
      const identity = identityFor(owner, createdByMemberId, providerName);
      const objective = snippet(input.text, 500);
      const rootMessage = await postMessage({
        workspaceId: owner.workspaceId,
        channelId: channel.id,
        authorMemberId: createdByMemberId,
        alsoSentToChannel: true,
        body: input.text,
      });
      await deliverPostedMessage(input.log, identity, channel, rootMessage);
      if (input.providerMessageId) {
        await recordExternalRoomMessageReceipt({
          workspaceId: owner.workspaceId,
          channelId: channel.id,
          messageId: rootMessage.id,
          provider: input.provider,
          providerConversationId: input.providerConversationId,
          providerMessageId: input.providerMessageId,
          direction: "inbound",
        });
      }

      const selectedAgents = LAUNCH_HANDLES.map((handle) => {
        const agent = seeded.agents.find((candidate) => candidate.handle === handle);
        return agent ? { handle, agentMemberId: agent.agentMemberId } : null;
      }).filter((agent): agent is { handle: (typeof LAUNCH_HANDLES)[number]; agentMemberId: string } => agent !== null);
      if (selectedAgents.length === 0) throw new Error("marketing seed did not create launch agents");

      const codexStatus = await options.codexSubscription.status(owner.workspaceId, createdByMemberId);
      if (!codexStatus.connected) {
        const authorMemberId = selectedAgents[0]?.agentMemberId ?? createdByMemberId;
        const agentIdentity: Identity = {
          workspaceId: owner.workspaceId,
          memberId: authorMemberId,
          kind: selectedAgents[0] ? "agent" : "human",
          displayName: selectedAgents[0] ? displayHandle(selectedAgents[0].handle) : providerName,
        };
        const blocked = await postMessage({
          workspaceId: owner.workspaceId,
          channelId: channel.id,
          authorMemberId,
          parentMessageId: rootMessage.id,
          alsoSentToChannel: true,
          body:
            "The marketing team is ready, but the agent runtime is not connected for this workspace yet.\nConnect it here: " +
            appUrl,
        });
        await deliverPostedMessage(input.log, agentIdentity, channel, blocked);
        return {
          status: "blocked_auth",
          workspaceId: owner.workspaceId,
          channelId: channel.id,
          messageId: rootMessage.id,
          codexStatus,
          replyText:
            "I opened the marketing room, but the agent runtime is not connected yet. Connect it in ipop, then send the brief again: " +
            appUrl,
        };
      }

      const subtasks = selectedAgents.map((agent) => buildSubtask(agent.handle, agent.agentMemberId, objective));
      for (const subtask of subtasks) {
        await addChannelMember(channel.id, subtask.agentMemberId);
        await grantCapability({
          workspaceId: owner.workspaceId,
          memberId: subtask.agentMemberId,
          resourceType: "channel",
          resourceId: channel.id,
          capability: "write",
          grantedByMemberId: createdByMemberId,
        });
      }

      const teamRunId = newId();
      void options.coordinator
        .runTeam({
          workspaceId: owner.workspaceId,
          channelId: channel.id,
          createdByMemberId,
          teamRunId,
          subtasks,
        })
        .catch((err) => {
          input.log.error({ err, teamRunId }, "inbound messaging team run crashed");
        });

      const names = listNames(selectedAgents.map((agent) => displayHandle(agent.handle)));
      return {
        status: "launched",
        workspaceId: owner.workspaceId,
        channelId: channel.id,
        messageId: rootMessage.id,
        teamRunId,
        subtaskCount: subtasks.length,
        replyText:
          names +
          " are in the room. They are starting on: " +
          snippet(objective, 120) +
          "\nUseful drafts and approval requests will mirror back here." +
          "\nOpen the full room: " +
          appUrl,
      };
    },
  };
}
