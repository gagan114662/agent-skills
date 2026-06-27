import { useEffect, useState } from "react";
import type { ApprovalRequestDto } from "@reload/shared";
import { api } from "../../api/client.js";
import type {
  ConnectionView,
  FirstRunReceiptDto,
  FirstRunReceiptInput,
  IMessageStatusResponse,
  TeamRunSubtaskInput,
} from "../../api/types.js";
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
        {
          label: "site reads",
          value: "1",
          detail: firstRun.target,
          tone: "good",
          proofKind: "live",
          proof: firstRun.receipt,
        },
        {
          label: "agent artifacts",
          value: "1",
          detail: firstRun.artifactTitle,
          tone: "good",
          proofKind: "dogfood",
          proof: firstRun.artifactSummary,
        },
        {
          label: "receipts",
          value: String(data.transparency.length + 1),
          detail: firstRun.receipt,
          tone: "good",
          proofKind: "live",
          proof: "first-run receipt persisted",
        },
        {
          label: "blocked sends",
          value: "0",
          detail: "nothing external sent without approval",
          tone: "neutral",
          proofKind: "live",
          proof: "no external transparency receipt created",
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
      readiness: [
        { label: "auth", status: "ready", proof: "signed-in workspace state loaded" },
        { label: "connectors", status: "blocked", proof: "external connector proof still required" },
        { label: "first run", status: "ready", proof: firstRun.receipt },
        { label: "outbound", status: "blocked", proof: "no real sent-message receipt" },
        { label: "billing", status: "pending", proof: "plan limits not attached to this brief" },
        { label: "observability", status: "pending", proof: "team health/audit feed not attached here" },
        { label: "legal/trust", status: "pending", proof: "legal state not attached to workspace brief" },
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

function connectorFromConnection(
  connection: ConnectionView,
  imessageStatus?: IMessageStatusResponse | null,
): EverydayConnector {
  const isIMessage = connection.id === "imessage";
  const imessageRecipient = isIMessage ? imessageStatus?.memberRecipient : null;
  const imessageRelayReady = Boolean(
    isIMessage &&
      imessageRecipient?.verified &&
      imessageStatus?.enabled &&
      imessageStatus.configured &&
      !imessageStatus.dryRun,
  );
  const status = imessageRelayReady
    ? "connected"
    : imessageRecipient
      ? "pending"
      : connection.connected
        ? "connected"
        : connection.status;
  return {
    id: connection.id,
    group: groupForConnection(connection),
    name: connection.label.replace(/^connect\s+/i, "").replace(/^sign in with\s+/i, ""),
    status,
    detail:
      isIMessage && imessageRecipient
        ? imessageRelayReady
          ? "live relay verified for " + imessageRecipient.recipient
          : imessageRecipient.verified
            ? "recipient verified; relay is " +
              (imessageStatus?.dryRun ? "dry-run" : imessageStatus?.enabled ? "not live" : "disabled") +
              " before agents can use Messages"
          : "test needed before agents can relay to " + imessageRecipient.recipient
        : connection.summary,
    actionLabel:
      connection.id === "imessage"
        ? "set up iMessage"
        : connection.status === "coming_soon"
          ? "notify me"
          : "connect",
  };
}

type RoomAgentRole = "Scout" | "Quill" | "Echo" | "Lens" | "Codex";

interface RoomAgentSpec {
  readonly role: RoomAgentRole;
  readonly lane: string;
  readonly immediateRequest: (goal: string) => string;
  readonly outputFormat: readonly string[];
}

const ROOM_AGENT_TASKS: readonly RoomAgentSpec[] = [
  {
    role: "Scout",
    lane: "insight mining",
    immediateRequest: (goal) =>
      "Mine customer/category/product/user/time/space insights for " +
      goal +
      " from public evidence. Rank the strongest tensions before recommending work.",
    outputFormat: [
      "top 5 ranked insights with evidence strength",
      "what to ask the brand next",
      "one recommended first useful move",
    ],
  },
  {
    role: "Quill",
    lane: "creative platform",
    immediateRequest: (goal) =>
      "Turn the strongest insight into a distinctive marketing platform for " +
      goal +
      ". Reference award-winning work from another category and adapt the mechanism, not the surface.",
    outputFormat: [
      "campaign platform",
      "why it is not generic AI copy",
      "first asset draft ready for approval",
    ],
  },
  {
    role: "Echo",
    lane: "distribution",
    immediateRequest: (goal) =>
      "Plan the first outreach/content distribution moves for " +
      goal +
      ". Do not send externally; prepare approval-ready drafts and connector blockers.",
    outputFormat: [
      "channel sequence",
      "approval-ready drafts",
      "connectors or policies blocking real sends",
    ],
  },
  {
    role: "Lens",
    lane: "taste and proof",
    immediateRequest: (goal) =>
      "Review the work for brand taste, originality, proof, and anti-slop quality for " +
      goal +
      ". Challenge weak insights before anything ships.",
    outputFormat: [
      "taste verdict",
      "specific slop risks to remove",
      "approval criteria before publishing or sending",
    ],
  },
  {
    role: "Codex",
    lane: "codex_operator_lane",
    immediateRequest: (goal) =>
      "Act as the implementation operator for the marketing room. Convert approved product, website, workflow, connector, or observability decisions into implementation tasks, PRs, issues, or verified fixes for " +
      goal +
      ". Report links and verification back into the room.",
    outputFormat: [
      "codex_operator_lane receipt",
      "files, PRs, issues, or artifacts changed",
      "verification performed",
      "residual risks and next recommended work",
    ],
  },
];

const PROMPT_STRUCTURE_LABELS = [
  "1. Task context",
  "2. Tone context",
  "3. Background data, documents, and images",
  "4. Detailed task description & rules",
  "5. Examples",
  "6. Conversation history",
  "7. Immediate task description or request",
  "8. Thinking step by step / take a deep breath",
  "9. Output formatting",
  "10. Prefilled response (if any)",
] as const;

function structuredRoomTask(spec: RoomAgentSpec, goal: string): string {
  const baseSections = [
    [
      PROMPT_STRUCTURE_LABELS[0],
      "You are " +
        spec.role +
        " in ipop's live marketing room. Work on the owner's current growth goal: " +
        goal +
        ". Your lane is " +
        spec.lane +
        ".",
    ],
    [
      PROMPT_STRUCTURE_LABELS[1],
      "Warm, plain, sharp, and useful. Think innocent-drinks-ish: human and a little playful, never fake, never corporate sludge.",
    ],
    [
      PROMPT_STRUCTURE_LABELS[2],
      "Use the workspace channel, public website/category evidence, connected-account receipts, approval state, and any uploaded brand material. If proof is missing, say exactly what is missing instead of inventing it.",
    ],
    [
      PROMPT_STRUCTURE_LABELS[3],
      "Do real marketing work. Mine, rank, and validate insights through product, user, time, space, purchase journey, competing products, intrinsic benefits, and culture. Adapt mechanisms from excellent work in other categories; do not copy surface style. Do not send, publish, spend, or claim external customer proof without connector receipts and owner approval.",
    ],
    [
      PROMPT_STRUCTURE_LABELS[4],
      "Good: a specific tension with evidence, a clear audience, a draft or decision the owner can act on. Bad: generic slogans, unsupported claims, fake connected states, or dashboard theatre.",
    ],
    [
      PROMPT_STRUCTURE_LABELS[5],
      "Read the live room thread and prior agent handoffs before acting. Build on the latest Scout/Quill/Echo/Lens/Operator messages; call out conflicts rather than smoothing them over.",
    ],
    [PROMPT_STRUCTURE_LABELS[6], spec.immediateRequest(goal)],
    [
      PROMPT_STRUCTURE_LABELS[7],
      "Reason step by step internally, check evidence before confidence, then return the concise work product. Do not expose hidden chain-of-thought.",
    ],
    [PROMPT_STRUCTURE_LABELS[8], spec.outputFormat.map((item) => "- " + item).join("\n")],
    [PROMPT_STRUCTURE_LABELS[9], "None."],
  ];

  const rendered = baseSections.map(([heading, body]) => heading + "\n" + body).join("\n\n");
  if (spec.role !== "Codex") return rendered;
  return (
    "codex_work_packet\n" +
    "audit_label: codex_operator_lane\n" +
    "credential_boundary: use the signed-in Codex runtime only; do not request or store API keys, cookies, passwords, or browser session secrets.\n\n" +
    rendered +
    "\n\nReturn payload schema:\n" +
    "- summary\n" +
    "- files_or_artifacts\n" +
    "- pr_or_issue_links\n" +
    "- verification\n" +
    "- residual_risks\n" +
    "- next_recommended_work"
  );
}

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
      task: structuredRoomTask(spec, goal),
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

async function activateFirstRunTeam(
  state: AppState,
  pending: FirstRunReceiptInput,
): Promise<void> {
  const workspaceId = state.identity?.workspaceId;
  if (!workspaceId) throw new Error("No signed-in workspace is ready for first-run activation.");
  await api.department.seed(workspaceId, { welcomeTasks: true });
  await api.department.brief(workspaceId, {
    lead: "scout",
    goal:
      "Use the first-run site read for " +
      pending.target +
      ". Finding: " +
      pending.finding +
      " Turn it into the next useful marketing move, keep send/spend gated, and leave receipts.",
  });
}

export function LiveEverydayShell({
  dashboardFirst = false,
}: { dashboardFirst?: boolean } = {}): React.JSX.Element {
  const state = useAppState();
  const store = useStore();
  const [connections, setConnections] = useState<readonly ConnectionView[] | null>(null);
  const [imessageStatus, setIMessageStatus] = useState<IMessageStatusResponse | null>(null);
  const [firstRun, setFirstRun] = useState<FirstRunReceiptDto | null>(null);

  async function refreshConnections(): Promise<void> {
    const response = await api.getConnections();
    setConnections(response.connections.filter((connection) => connection.audience === "customer"));
  }

  async function refreshIMessageStatus(): Promise<void> {
    setIMessageStatus(await api.getIMessageStatus());
  }

  async function refreshFirstRun(): Promise<void> {
    const pending = readPendingFirstRunReceipt();
    if (pending) {
      const response = await api.recordFirstRunReceipt(pending);
      await activateFirstRunTeam(state, pending);
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
    void refreshIMessageStatus().catch(() => setIMessageStatus(null));
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
        connectors: connections
          ? connections.map((connection) => connectorFromConnection(connection, imessageStatus))
          : data.connectors,
      }}
      onConnectorConnect={(id) => void connect(id)}
      imessageStatus={imessageStatus}
      onSaveIMessageRecipient={async (input) => {
        await api.saveIMessageRecipient(input);
        await refreshIMessageStatus();
      }}
      onTestIMessageRecipient={async () => {
        const result = await api.testIMessageRecipient();
        await refreshIMessageStatus();
        if (result.status !== "sent") {
          throw new Error(result.error ?? "iMessage relay did not send a live test message.");
        }
      }}
      onDeleteIMessageRecipient={async () => {
        await api.deleteIMessageRecipient();
        await refreshIMessageStatus();
      }}
      onStartRoom={(goal) => launchCodexRoomRun(state, goal)}
      dashboardFirst={dashboardFirst}
    />
  );
}
