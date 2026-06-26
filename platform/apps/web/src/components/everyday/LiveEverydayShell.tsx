import { useEffect, useState } from "react";
import type { ApprovalRequestDto } from "@reload/shared";
import { api } from "../../api/client.js";
import type { ConnectionView } from "../../api/types.js";
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
    actionLabel: connection.status === "coming_soon" ? "notify me" : "connect",
  };
}

export function LiveEverydayShell(): React.JSX.Element {
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
    />
  );
}
