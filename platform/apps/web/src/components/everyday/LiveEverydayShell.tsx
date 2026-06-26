import { useEffect, useState } from "react";
import type { ApprovalRequestDto } from "@reload/shared";
import { api } from "../../api/client.js";
import type { ConnectionView, TeamRunSubtaskInput } from "../../api/types.js";
import type { AppState } from "../../store/store.js";
import { authorLabel } from "../../store/store.js";
import { useAppState, useStore } from "../../store/StoreContext.js";
import { EverydayShell } from "./EverydayShell.js";
import {
  emptyEverydayData,
  type ApprovalCard,
  type EverydayConnector,
  type EverydayData,
  type ThreadEntry,
} from "./everyday-data.js";

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function payloadPreview(request: ApprovalRequestDto): string {
  const candidates = [
    request.payload.body,
    request.payload.draft,
    request.payload.message,
    request.payload.summary,
    request.payload.text,
  ];
  return candidates.map(asText).find(Boolean) ?? request.summary;
}

function approvalCard(request: ApprovalRequestDto, state: AppState): ApprovalCard {
  const action = request.actionType.replace(/[._-]+/g, " ");
  const requester = authorLabel(state.directory, request.requesterMemberId);
  return {
    id: request.id,
    approvalRequestId: request.id,
    agent: requester,
    deliverable: {
      title: request.summary || action,
      kind: "draft",
      preview: payloadPreview(request),
    },
    consequence: action,
    costsMoney: request.amount !== null && request.amount > 0,
    amount: request.amount !== null ? "$" + request.amount : undefined,
  };
}

function threadEntries(state: AppState): ThreadEntry[] {
  const channelId = state.activeChannelId;
  const messages = channelId ? state.messagesByChannel[channelId] ?? [] : [];
  const visible = messages.slice(-8);
  return visible.map((message, index) => ({
    id: message.id,
    kind: "agent-line",
    agent: authorLabel(state.directory, message.authorMemberId),
    at: index === visible.length - 1 ? "latest" : "workspace",
    text: message.body,
  }));
}

export function liveEverydayDataFromState(state: AppState): EverydayData {
  const data = emptyEverydayData(state.identity?.displayName ?? "there");
  return {
    ...data,
    thread: threadEntries(state),
    approvals: state.approvals.requests
      .filter((request) => request.status === "pending")
      .map((request) => approvalCard(request, state)),
    fleetPaused: state.liveSessions.length === 0,
  };
}

function groupForConnection(connection: ConnectionView): EverydayConnector["group"] {
  if (connection.capabilities.includes("work_visibility")) return "visibility";
  if (connection.capabilities.includes("site_publish")) return "publishing";
  if (connection.capabilities.includes("post_social") || connection.capabilities.includes("ads")) return "marketing";
  return "productivity";
}

function connectorFromConnection(connection: ConnectionView): EverydayConnector {
  return {
    id: connection.id,
    group: groupForConnection(connection),
    name: connection.label.replace(/^connect\s+/i, "").replace(/^sign in with\s+/i, ""),
    status: connection.connected ? "connected" : connection.status,
    detail: connection.summary,
    actionLabel: connection.id === "imessage" ? "set up iMessage" : connection.status === "coming_soon" ? "notify me" : "connect",
  };
}

const ROOM_AGENT_TASKS: Array<{ role: string; task: (goal: string) => string }> = [
  {
    role: "Scout",
    task: (goal) =>
      "Mine customer/category/product/user/time/space insights for: " +
      goal +
      ". Start from public evidence and rank the strongest tensions before recommending work.",
  },
  {
    role: "Quill",
    task: (goal) =>
      "Turn the strongest insight into a distinctive marketing platform for: " +
      goal +
      ". Reference award-winning work from another category and adapt the mechanism, not the surface.",
  },
  {
    role: "Echo",
    task: (goal) =>
      "Plan the first outreach/content distribution moves for: " +
      goal +
      ". Do not send externally; prepare approval-ready drafts and connector blockers.",
  },
  {
    role: "Lens",
    task: (goal) =>
      "Review the work for brand taste, originality, proof, and anti-slop quality for: " +
      goal +
      ". Challenge weak insights before anything ships.",
  },
  {
    role: "Codex",
    task: (goal) =>
      "Act as the implementation operator for the marketing room. Convert approved product/website/workflow decisions into implementation tasks, PRs, or verified fixes for: " +
      goal +
      ". Report links and verification back into the room.",
  },
];

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "room";
}

async function resolveAgentMemberId(state: AppState, role: string): Promise<string | null> {
  const cached = Object.values(state.directory).find(
    (entry) => entry.kind === "agent" && entry.displayName.toLowerCase().includes(role.toLowerCase()),
  );
  if (cached) return cached.id;
  const workspaceId = state.identity?.workspaceId;
  if (!workspaceId) return null;
  const hits = await api.searchMembers(workspaceId, role).catch(() => []);
  return hits.find((hit) => hit.kind === "agent")?.id ?? null;
}

async function launchCodexRoomRun(state: AppState, goal: string): Promise<void> {
  const channelId = state.activeChannelId;
  if (!channelId) throw new Error("Open a workspace channel before starting the iMessage room.");
  const codex = await api.getCodexStatus();
  if (!codex.connected) {
    throw new Error(
      "The team engine is not connected to your signed-in subscription yet. Connect it before starting the agent room.",
    );
  }
  await api.postMessage(channelId, goal).catch(() => undefined);

  const subtasks: TeamRunSubtaskInput[] = [];
  for (const spec of ROOM_AGENT_TASKS) {
    const agentMemberId = await resolveAgentMemberId(state, spec.role);
    if (!agentMemberId) continue;
    subtasks.push({
      agentMemberId,
      task: spec.task(goal),
      branch: "ipop-" + slug(spec.role) + "-" + slug(goal),
      harness: "codex",
    });
  }
  if (subtasks.length === 0) {
    throw new Error("No Scout/Quill/Echo/Lens/operator agents were found in this workspace roster yet.");
  }
  await api.launchTeamRun(channelId, subtasks);
}

export function LiveEverydayShell({ dashboardFirst = false }: { dashboardFirst?: boolean } = {}): React.JSX.Element {
  const state = useAppState();
  const store = useStore();
  const [connections, setConnections] = useState<readonly ConnectionView[] | null>(null);

  async function refreshConnections(): Promise<void> {
    const response = await api.getConnections();
    setConnections(response.connections.filter((connection) => connection.audience === "customer"));
  }

  useEffect(() => {
    if (state.phase !== "ready") return;
    void store.loadApprovals("pending");
    void refreshConnections().catch(() => setConnections(null));
  }, [state.phase, state.identity?.workspaceId, store]);

  async function connect(id: string): Promise<void> {
    const connection = connections?.find((item) => item.id === id);
    if (!connection) return;
    if (connection.connected) return;
    if (connection.status === "coming_soon") {
      await api.joinConnectionWaitlist(id).catch(() => undefined);
      return;
    }
    if (connection.auth === "one_click") await api.enableConnection(id);
    else await api.startConnectionOAuth(id);
    await refreshConnections();
  }

  const data = liveEverydayDataFromState(state);
  return (
    <EverydayShell
      data={{
        ...data,
        connectors: connections ? connections.map(connectorFromConnection) : data.connectors,
      }}
      onConnectorConnect={(id) => void connect(id)}
      onStartRoom={(goal) => launchCodexRoomRun(state, goal)}
      dashboardFirst={dashboardFirst}
    />
  );
}
