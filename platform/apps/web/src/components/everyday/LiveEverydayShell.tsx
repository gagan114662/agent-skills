import { useEffect, useState } from "react";
import type { ApprovalRequestDto } from "@reload/shared";
import { api } from "../../api/client.js";
import type { ConnectionView, FirstRunReceiptDto, TeamRunSubtaskInput } from "../../api/types.js";
import type { AppState } from "../../store/store.js";
import { authorLabel } from "../../store/store.js";
import { useAppState, useStore } from "../../store/StoreContext.js";
import {
  clearPendingFirstRunReceipt,
  readPendingFirstRunReceipt,
} from "../onboarding/first-run-receipt.js";
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
  const messages = channelId ? (state.messagesByChannel[channelId] ?? []) : [];
  const visible = messages.slice(-8);
  return visible.map((message, index) => ({
    id: message.id,
    kind: "agent-line",
    agent: authorLabel(state.directory, message.authorMemberId),
    at: index === visible.length - 1 ? "latest" : "workspace",
    text: message.body,
  }));
}

function firstRunTime(firstRun: FirstRunReceiptDto): string {
  return new Date(firstRun.recordedAtMs).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function stageLabel(stage: FirstRunReceiptDto["stage"]): string {
  if (stage === "source_read") return "source read";
  if (stage === "dashboard_receipt") return "dashboard receipt";
  return "agent result";
}

function withFirstRunReceipt(
  data: EverydayData,
  firstRun: FirstRunReceiptDto | null,
): EverydayData {
  if (!firstRun) return data;
  const receiptAction = {
    id: "first-run-" + firstRun.recordedAtMs,
    at: firstRunTime(firstRun),
    action: "recorded first result for " + firstRun.target,
    href: "#dashboard",
    receiptLabel: firstRun.receipt,
  };
  return {
    ...data,
    thread:
      data.thread.length > 0
        ? data.thread
        : [
            {
              id: "first-run-scout",
              kind: "agent-line",
              agent: "Scout",
              at: "first run",
              text: firstRun.finding,
            },
            {
              id: "first-run-quill",
              kind: "deliverable",
              agent: "Quill",
              at: "queued",
              deliverable: {
                title: firstRun.artifactTitle,
                kind: "draft",
                preview: firstRun.artifactSummary,
              },
            },
          ],
    transparency: data.transparency.some((entry) => entry.id === receiptAction.id)
      ? data.transparency
      : [...data.transparency, receiptAction],
    marketingBrief: {
      mode: "live",
      headline: firstRun.finding,
      goal: {
        label: "first-run stage",
        target: "first useful marketing result",
        current: stageLabel(firstRun.stage),
        pace: "receipt captured",
        confidence: "medium",
      },
      metrics: [
        { label: "site reads", value: "1", detail: firstRun.target, tone: "good" },
        { label: "agent artifacts", value: "1", detail: firstRun.artifactTitle, tone: "good" },
        {
          label: "receipts",
          value: String(data.transparency.length + 1),
          detail: firstRun.receipt,
          tone: "good",
        },
        {
          label: "blocked sends",
          value: "0",
          detail: "nothing external sent without approval",
          tone: "neutral",
        },
      ],
      funnel: [
        { label: "source", count: "1", detail: firstRun.target, tone: "good" },
        { label: "insight", count: "1", detail: "site finding recorded", tone: "good" },
        { label: "asset", count: "1", detail: firstRun.artifactTitle, tone: "good" },
        {
          label: "approved",
          count: String(data.approvals.length),
          detail: "owner queue",
          tone: data.approvals.length ? "warn" : "neutral",
        },
        {
          label: "sent",
          count: "0",
          detail: "waiting for real connector approval",
          tone: "neutral",
        },
      ],
      channels: [
        {
          source: "website",
          status: "read",
          pipeline: firstRun.artifactTitle,
          conversion: "not measured yet",
          spend: "$0",
          next: "turn the finding into approved copy and connector-backed distribution",
        },
      ],
      blockers: [
        {
          title: "real connector proof",
          owner: "owner",
          proof: "connect Gmail, social, or site publishing before external sends",
        },
      ],
      decisions: [
        {
          title: "approve the first angle",
          owner: "owner",
          proof: firstRun.receipt,
        },
      ],
      nextActions: [
        {
          title: "build launch-week plan from the finding",
          owner: "Quill",
          proof: firstRun.artifactSummary,
        },
      ],
    },
  };
}

export function liveEverydayDataFromState(
  state: AppState,
  firstRun: FirstRunReceiptDto | null = null,
): EverydayData {
  const data = emptyEverydayData(state.identity?.displayName ?? "there");
  return withFirstRunReceipt(
    {
      ...data,
      thread: threadEntries(state),
      approvals: state.approvals.requests
        .filter((request) => request.status === "pending")
        .map((request) => approvalCard(request, state)),
      fleetPaused: state.liveSessions.length === 0,
    },
    firstRun,
  );
}

function groupForConnection(connection: ConnectionView): EverydayConnector["group"] {
  if (connection.capabilities.includes("work_visibility")) return "visibility";
  if (connection.capabilities.includes("site_publish")) return "publishing";
  if (connection.capabilities.includes("post_social") || connection.capabilities.includes("ads"))
    return "marketing";
  return "productivity";
}

function connectorFromConnection(connection: ConnectionView): EverydayConnector {
  return {
    id: connection.id,
    group: groupForConnection(connection),
    name: connection.label.replace(/^connect\s+/i, "").replace(/^sign in with\s+/i, ""),
    status: connection.connected ? "connected" : connection.status,
    detail: connection.summary,
    actionLabel:
      connection.id === "imessage"
        ? "set up iMessage"
        : connection.status === "coming_soon"
          ? "notify me"
          : "connect",
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
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "room"
  );
}

async function resolveAgentMemberId(state: AppState, role: string): Promise<string | null> {
  const cached = Object.values(state.directory).find(
    (entry) =>
      entry.kind === "agent" && entry.displayName.toLowerCase().includes(role.toLowerCase()),
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
  const relay = await api.startIMessageRoom(channelId, goal);
  if (relay.status !== "sent") {
    throw new Error(
      relay.error ??
        "iMessage relay is not ready for this workspace yet. Set up Messages before starting the agent room.",
    );
  }

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
    throw new Error(
      "No Scout/Quill/Echo/Lens/operator agents were found in this workspace roster yet.",
    );
  }
  await api.launchTeamRun(channelId, subtasks);
}

export function LiveEverydayShell({
  dashboardFirst = false,
}: { dashboardFirst?: boolean } = {}): React.JSX.Element {
  const state = useAppState();
  const store = useStore();
  const [connections, setConnections] = useState<readonly ConnectionView[] | null>(null);
  const [firstRun, setFirstRun] = useState<FirstRunReceiptDto | null>(null);

  async function refreshConnections(): Promise<void> {
    const response = await api.getConnections();
    setConnections(response.connections.filter((connection) => connection.audience === "customer"));
  }

  async function refreshFirstRun(): Promise<void> {
    const pending = readPendingFirstRunReceipt();
    if (pending) {
      const response = await api.recordFirstRunReceipt(pending);
      clearPendingFirstRunReceipt();
      setFirstRun(response.firstRun);
      return;
    }
    const response = await api.getFirstRunReceipt();
    setFirstRun(response.firstRun);
  }

  useEffect(() => {
    if (state.phase !== "ready") return;
    void store.loadApprovals("pending");
    void refreshConnections().catch(() => setConnections(null));
    void refreshFirstRun().catch(() => setFirstRun(null));
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

  const data = liveEverydayDataFromState(state, firstRun);
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
