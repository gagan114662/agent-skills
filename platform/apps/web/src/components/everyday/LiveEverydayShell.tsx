import { useEffect, useState } from "react";
import type { ApprovalRequestDto, TeamEvent, MarketingDraft } from "@reload/shared";
import { api } from "../../api/client.js";
import type {
  ConnectionView,
  RuntimeStatus,
  FirstRunReceiptDto,
  FirstRunReceiptInput,
  IMessageStatusResponse,
  Message,
  TeamArtifactKind,
  TeamRunSubtaskInput,
} from "../../api/types.js";
import type { AppState, LiveSessionLite } from "../../store/store.js";
import { useAppState, useStore } from "../../store/StoreContext.js";
import { useLiveChannelMessages } from "../console/useLiveChannelMessages.js";
import { useLiveMissionControl } from "../console/useLiveMissionControl.js";
import {
  clearPendingFirstRunReceipt,
  readPendingFirstRunReceipt,
} from "../onboarding/first-run-receipt.js";
import { usePublicLightTheme } from "../../design/public-theme.js";
import { EverydayShell, type EverydayRoomLaunchResult, type EverydayShellTheme } from "./EverydayShell.js";
import {
  canonicalRoomAgentName,
  customerVisibleAgentText,
  isSessionOutcomeSuccessLine,
  parseTeamEvent,
  teamEventAgentName,
  teamEventFriendlyLine,
} from "./everyday-agent-text.js";
import {
  CMO_SUMMARY_ENABLED,
  CMO_SUMMARY_OWNER_WORKSPACE_ID,
  shouldShowCmoSummary,
} from "./cmo-summary-flag.js";
import {
  defaultConnectors,
  emptyEverydayData,
  type AgentLane,
  type ApprovalCard,
  type EverydayConnector,
  type EverydayConnectorConnectResult,
  type EverydayData,
  type LaunchReadinessItem,
  type ThreadEntry,
} from "./everyday-data.js";

const STARTER_AGENT_SEAT_LIMIT = 5;

function navigateToTelegramStart(link: Awaited<ReturnType<typeof api.startTelegramConnection>>): void {
  if (link.startUrl) {
    window.location.assign(link.startUrl);
    return;
  }
  void navigator.clipboard?.writeText(link.startCommand);
}

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
  const requester = resolvedRoomAgent(state, request.requesterMemberId);
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

function parseTeamEventMessage(message: Message): TeamEvent | null {
  return parseTeamEvent(message.body);
}

/**
 * The named teammate a room message is from — never a raw `member-019eb7` id or the literal "workspace"
 * (#1584 rule 1). Prefer the workspace directory display name, fall back to the agent a team-event's
 * lifecycle summary names, and only then to a plain "the team" — the customer always sees a person.
 */
function resolvedRoomAgent(
  state: AppState,
  memberId: string,
  event: TeamEvent | null = null,
): string {
  const display = state.directory[memberId]?.displayName;
  if (display) return canonicalRoomAgentName(display);
  if (event) {
    const named = teamEventAgentName(event);
    if (named) return named;
  }
  return "the team";
}

/**
 * A subtle, honest timestamp for a room line (#1584 rule 4) — the event's clock time when we have it,
 * "just now" for the newest line, and nothing (never "workspace") for older, timestamp-less messages.
 */
function threadAtLabel(createdAt: string | null | undefined, isLatest: boolean): string {
  if (createdAt) {
    const when = new Date(createdAt);
    if (!Number.isNaN(when.getTime())) {
      return when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
  }
  return isLatest ? "just now" : "";
}

function draftText(draft: MarketingDraft): string {
  const fields = Object.entries(draft.fields).flatMap(([field, value]) => {
    if (Array.isArray(value)) return value.map((item) => field + ": " + item);
    return field + ": " + value;
  });
  return fields.join("\n");
}

function teamEventThreadEntry(
  message: Message,
  event: TeamEvent,
  index: number,
  visibleCount: number,
  state: AppState,
): ThreadEntry {
  const agent = resolvedRoomAgent(state, event.agentMemberId, event);
  const at = threadAtLabel(event.createdAt, index === visibleCount - 1);
  if (event.artifact?.kind === "draft_set") {
    const firstDraft = event.artifact.drafts?.[0];
    if (firstDraft) {
      return {
        id: message.id,
        teamRunId: event.teamRunId,
        kind: "deliverable",
        agent: agent.toLowerCase().includes("quill") ? agent : "Quill",
        at,
        deliverable: {
          title: firstDraft.title,
          kind: "draft",
          preview: draftText(firstDraft),
        },
      };
    }
  }
  return {
    id: message.id,
    teamRunId: event.teamRunId,
    kind: "agent-line",
    agent,
    at,
    text: teamEventFriendlyLine(event),
  };
}

function threadEntries(state: AppState): ThreadEntry[] {
  const channelId = state.activeChannelId;
  const messages = channelId ? (state.messagesByChannel[channelId] ?? []) : [];
  // Drop the runtime's exit-code success line (`✅ session completed (exit 0)`) — pure plumbing that must
  // never surface as a bubble; the real deliverable is posted as its own message (#1584 rule 4).
  const visible = messages
    .filter((message) => !isSessionOutcomeSuccessLine(message.body ?? ""))
    .slice(-8);
  return visible.map((message, index) => {
    const event = parseTeamEventMessage(message);
    if (event) return teamEventThreadEntry(message, event, index, visible.length, state);
    return {
      id: message.id,
      kind: "agent-line",
      agent: resolvedRoomAgent(state, message.authorMemberId),
      at: threadAtLabel(null, index === visible.length - 1),
      // Never render a raw body: a malformed team-event blob, a session failure line, or a runtime/log
      // line becomes honest brand-voice text; genuine human messages pass through unchanged.
      text: customerVisibleAgentText(message.body ?? ""),
    };
  });
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

function firstRunHasContentDraft(firstRun: FirstRunReceiptDto): boolean {
  if (firstRun.stage !== "agent_result") return false;
  if (!firstRun.artifactTitle) return false;
  return !/\b(?:site[- ]?read|receipt|research|source read)\b/i.test(firstRun.artifactTitle);
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
  const hasContentDraft = firstRunHasContentDraft(firstRun);
  const emptyThread: ThreadEntry[] = [
    {
      id: "first-run-scout",
      kind: "agent-line",
      agent: "Scout",
      at: "first run",
      text: firstRun.finding,
    },
    ...(hasContentDraft
      ? [
          {
            id: "first-run-quill",
            kind: "deliverable" as const,
            agent: "Quill",
            at: "queued",
            deliverable: {
              title: firstRun.artifactTitle,
              kind: "draft" as const,
              preview: firstRun.artifactSummary,
            },
          },
        ]
      : []),
  ];
  return {
    ...data,
    thread: data.thread.length > 0 ? data.thread : emptyThread,
    transparency: data.transparency.some((entry) => entry.id === receiptAction.id)
      ? data.transparency
      : [...data.transparency, receiptAction],
    marketingBrief: {
      mode: "live",
      headline: firstRun.finding,
      executiveSummary: [
        {
          label: "visible work",
          value: "1",
          detail: "first useful result captured",
          tone: "warn",
          proof: firstRun.receipt,
        },
        {
          label: "new customers",
          value: "0",
          detail: "no customer/revenue movement yet",
          tone: "bad",
          proof: "north-star customer row is unchanged",
        },
        {
          label: "needs your review",
          value: String(data.approvals.length),
          detail: data.approvals.length ? "owner decision needed" : "no owner queue",
          tone: data.approvals.length ? "warn" : "neutral",
          proof: "workspace approval queue",
        },
        {
          label: "channels to connect",
          value: "1",
          detail: "connect one channel so the team can actually reach people",
          tone: "bad",
          proof: "no real sent-message receipt",
        },
      ],
      sinceLastCheckIn: [
        { title: "First useful marketing result captured", owner: "Scout", proof: firstRun.receipt },
        {
          title: hasContentDraft ? "Draft artifact is ready for the owner" : "Research receipt captured; draft still pending",
          owner: hasContentDraft ? "Quill" : "Scout",
          proof: hasContentDraft ? firstRun.artifactTitle : firstRun.receipt,
        },
        { title: "External sends remain gated", owner: "Operator", proof: "no external transparency receipt created" },
      ],
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
          label: "drafts ready",
          value: hasContentDraft ? "1" : "0",
          detail: hasContentDraft ? firstRun.artifactTitle : "waiting for Quill or Echo content",
          tone: hasContentDraft ? "good" : "neutral",
          proofKind: "live",
          proof: hasContentDraft ? firstRun.artifactSummary : "site-read receipts are research, not drafts",
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
          label: "sent without approval",
          value: "0",
          detail: "nothing external sent without approval",
          tone: "neutral",
          proofKind: "live",
          proof: "no external transparency receipt created",
        },
      ],
      rankedWork: [
        {
          agent: "Scout",
          work: "first useful marketing result",
          impact: "turned a live source read into one owner-reviewable direction",
          status: "shipped",
          proof: firstRun.receipt,
        },
        {
          agent: hasContentDraft ? "Quill" : "Scout",
          work: hasContentDraft ? firstRun.artifactTitle : "read your website",
          impact: hasContentDraft
            ? "the draft is ready for you to approve, but hasn't won a customer yet"
            : "we've read your site; the team hasn't written a draft from it yet",
          status: hasContentDraft ? "queued" : "learning",
          proof: hasContentDraft ? firstRun.artifactSummary : firstRun.receipt,
        },
        {
          agent: "Echo",
          work: "reaching people outside ipop",
          impact: "waiting on one connected channel before anything can be sent",
          status: "blocked",
          proof: "no external transparency receipt created",
        },
      ],
      capacity: [
        {
          label: "campaigns running",
          value: "1 / 1",
          detail: "upgrade when a second lane queues",
          tone: "warn",
          proof: firstRun.receipt,
        },
        {
          label: "team members active",
          value: String(data.room.length) + " / " + STARTER_AGENT_SEAT_LIMIT,
          detail:
            data.room.length > STARTER_AGENT_SEAT_LIMIT
              ? "upgrade to keep the whole room active"
              : "inside starter team limit",
          tone: data.room.length > STARTER_AGENT_SEAT_LIMIT ? "warn" : "neutral",
          proof: "workspace agent lane state",
        },
        {
          label: "monthly work budget",
          value: "$0 / $200",
          detail: "no paid distribution approved yet",
          tone: "neutral",
          proof: "no paid campaign spend receipt",
        },
      ],
      funnel: [
        { label: "source", count: "1", detail: firstRun.target, tone: "good" },
        { label: "insight", count: "1", detail: "site finding recorded", tone: "good" },
        {
          label: "asset",
          count: hasContentDraft ? "1" : "0",
          detail: hasContentDraft ? firstRun.artifactTitle : "waiting for content draft",
          tone: hasContentDraft ? "good" : "neutral",
        },
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
          pipeline: hasContentDraft ? firstRun.artifactTitle : "research captured; draft pending",
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

function withRuntimeReadiness(
  data: EverydayData,
  runtimeStatus: RuntimeStatus | null,
): EverydayData {
  if (!runtimeStatus || !data.marketingBrief) return data;
  const auth: LaunchReadinessItem = {
    label: "auth",
    status: runtimeStatus.connected ? "ready" : "blocked",
    proof: runtimeStatus.connected
      ? "agent runtime is connected (" + runtimeStatus.provider + ")"
      : runtimeStatus.reason,
  };
  return {
    ...data,
    marketingBrief: {
      ...data.marketingBrief,
      readiness: data.marketingBrief.readiness.map((item) =>
        item.label === "auth" ? auth : item,
      ),
    },
  };
}

function laneStatusFromLiveSession(session: LiveSessionLite): AgentLane["status"] {
  const lifecycle = session.status.toLowerCase();
  if (lifecycle.includes("fail") || lifecycle.includes("cancel") || lifecycle.includes("timeout")) {
    return "blocked";
  }
  if (lifecycle.includes("complete") || session.agentStatus === "done") return "done";
  if (session.agentStatus === "waiting") return "blocked";
  if (session.agentStatus === "idle") return "idle";
  return "working";
}

function liveSessionTask(agent: string, session: LiveSessionLite): string {
  const activity =
    session.agentStatus === "thinking"
      ? "thinking through the next marketing move"
      : session.agentStatus === "drafting"
        ? "drafting work for the room"
        : session.agentStatus === "handoff"
          ? "handing work to the next lane"
          : session.agentStatus === "waiting"
            ? "waiting on a connector, approval, or proof receipt"
            : session.agentStatus === "done"
              ? "finished its current room task"
              : "standing by";
  return agent + " is " + activity + " in this live room. Session " + session.id + " is " + session.status + ".";
}

function laneMatchesSession(lane: AgentLane, session: LiveSessionLite, state: AppState): boolean {
  const member = state.directory[session.agentMemberId];
  const name = member?.displayName.toLowerCase() ?? "";
  const agent = lane.agent.toLowerCase();
  if (lane.id === "codex") return name.includes("codex") || name.includes("operator");
  return name.includes(agent);
}

export function withLiveRoomSessions(data: EverydayData, state: AppState): EverydayData {
  const channelId = state.activeChannelId;
  if (!channelId) return data;
  const live = state.liveSessions.filter((session) => session.channelId === channelId);
  if (live.length === 0) return data;
  const room = data.room.map((lane) => {
    const session = live.find((item) => laneMatchesSession(lane, item, state));
    if (!session) return lane;
    return {
      ...lane,
      status: laneStatusFromLiveSession(session),
      task: liveSessionTask(lane.agent, session),
    };
  });
  const named = room.filter((lane) => live.some((session) => laneMatchesSession(lane, session, state)));
  const liveLine =
    named.length > 0
      ? named.map((lane) => lane.agent + " " + lane.status).join(", ")
      : String(live.length) + " live agent session(s)";
  return {
    ...data,
    room,
    marketingBrief: data.marketingBrief
      ? {
          ...data.marketingBrief,
          headline:
            "Live CMO readout from this workspace: " +
            liveLine +
            "; decisions, channel truth, and proof gaps stay visible.",
        }
      : data.marketingBrief,
  };
}

export function liveEverydayDataFromState(
  state: AppState,
  firstRun: FirstRunReceiptDto | null = null,
  runtimeStatus: RuntimeStatus | null = null,
): EverydayData {
  const data = emptyEverydayData(state.identity?.displayName ?? "there");
  const liveData = withLiveRoomSessions(
    {
      ...data,
      thread: threadEntries(state),
      approvals: state.approvals.requests
        .filter((request) => request.status === "pending")
        .map((request) => approvalCard(request, state)),
      fleetPaused: false,
    },
    state,
  );
  return withRuntimeReadiness(withFirstRunReceipt(liveData, firstRun), runtimeStatus);
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
  const relayHeartbeat = isIMessage ? imessageStatus?.relayHeartbeat : null;
  const relayMessagesAccess = relayHeartbeat?.messagesAccess ?? "unknown";
  const relayMessagesDbAccess = relayHeartbeat?.messagesDbAccess ?? "unknown";
  const imessageRelayReady = Boolean(
    isIMessage &&
      imessageRecipient?.verified &&
      imessageStatus?.enabled &&
      imessageStatus.configured &&
      !imessageStatus.dryRun &&
      relayHeartbeat?.active &&
      relayMessagesAccess === "ok" &&
      relayMessagesDbAccess === "ok",
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
            ? imessageStatus?.dryRun
              ? "recipient verified; relay is dry-run before agents can use Messages"
              : !imessageStatus?.enabled
                ? "recipient verified; relay is disabled before agents can use Messages"
                : relayHeartbeat?.active && relayMessagesAccess === "failed"
                  ? "recipient verified; relay cannot send through Messages yet"
                  : relayHeartbeat?.active && relayMessagesDbAccess === "failed"
                    ? "recipient verified; relay cannot read Messages replies yet"
                  : relayHeartbeat?.active
                    ? "recipient verified; relay API is live but Messages reply-sync access is not proven yet"
                    : "recipient verified; relay is not live before agents can use Messages"
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

type RoomAgentRole = "Scout" | "Quill" | "Echo" | "Lens" | "Operator";

interface RoomAgentSpec {
  readonly role: RoomAgentRole;
  readonly lane: string;
  readonly phase: number;
  readonly producesArtifacts?: readonly TeamArtifactKind[];
  readonly requiresArtifacts?: readonly TeamArtifactKind[];
  readonly immediateRequest: (goal: string) => string;
  readonly outputFormat: readonly string[];
}

const ROOM_AGENT_TASKS: readonly RoomAgentSpec[] = [
  {
    role: "Scout",
    lane: "insight mining",
    phase: 1,
    producesArtifacts: ["scout_research", "brand_voice"],
    immediateRequest: (goal) =>
      "Mine customer/category/product/user/time/space insights for " +
      goal +
      " from public evidence. Rank the strongest tensions before recommending work. Produce the required scout_research and brand_voice artifacts before you mark the lane done.",
    outputFormat: [
      "top 5 ranked insights with evidence strength",
      "what to ask the brand next",
      "one recommended first useful move",
    ],
  },
  {
    role: "Quill",
    lane: "creative platform",
    phase: 2,
    requiresArtifacts: ["scout_research", "brand_voice"],
    producesArtifacts: ["draft_set"],
    immediateRequest: (goal) =>
      "You own the drafts. Use the validated Scout research and brand_voice artifacts that the coordinator injects into this task, then turn the strongest proof points into a distinctive marketing platform for " +
      goal +
      ". Produce named, approval-ready draft assets for every format the owner requested. Reference award-winning work from another category and adapt the mechanism, not the surface. Produce the required draft_set artifact with channel-native formats that pass validation, and cite the artifact proofPoints, sourceUrls, or brand_voice rules used by each draft.",
    outputFormat: [
      "campaign platform",
      "why it is not generic AI copy",
      "named draft artifacts with format labels",
      "valid draft_set artifact for requested formats",
      "research proof points cited per draft",
      "first asset draft ready for approval",
    ],
  },
  {
    role: "Lens",
    lane: "taste and proof",
    phase: 3,
    requiresArtifacts: ["scout_research", "brand_voice", "draft_set"],
    producesArtifacts: ["lens_review"],
    immediateRequest: (goal) =>
      "Score every Quill draft for " +
      goal +
      " before it reaches the owner. Use the injected Scout research, brand_voice, and draft_set artifacts; apply the six-part rubric (specificity to business, hook strength, clarity, evidence use, CTA quality, voice consistency against the voice profile), write one concrete revision note per draft, and produce the required lens_review artifact. If any draft scores below 4, revise it once in the artifact before handoff. If a required draft is missing, name the missing artifact and the agent lane that failed instead of reviewing an empty workspace.",
    outputFormat: [
      "rubric scores per draft",
      "one concrete revision note per draft",
      "valid lens_review artifact",
      "approval criteria before publishing or sending",
    ],
  },
  {
    role: "Echo",
    lane: "distribution",
    phase: 4,
    requiresArtifacts: ["scout_research", "brand_voice", "draft_set", "lens_review"],
    immediateRequest: (goal) =>
      "Plan the first outreach/content distribution moves for " +
      goal +
      ". Use the injected brand_voice profile, Lens scores, and revised drafts; do not send externally; prepare approval-ready drafts and connector blockers.",
    outputFormat: [
      "channel sequence",
      "Lens-scored approval-ready drafts",
      "connectors or policies blocking real sends",
    ],
  },
  {
    // Provider-neutral implementation-operator lane (#1568). The lane id + receipt strings keep the
    // historical `codex_operator_lane` label because persisted audit receipts key off it.
    role: "Operator",
    lane: "codex_operator_lane",
    phase: 5,
    requiresArtifacts: ["lens_review"],
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
  if (spec.role !== "Operator") return rendered;
  return (
    "codex_work_packet\n" +
    "audit_label: codex_operator_lane\n" +
    "credential_boundary: use the workspace's connected agent runtime only; do not request or store API keys, cookies, passwords, or browser session secrets.\n\n" +
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

function codexOperatorPacket(goal: string): string {
  const spec = ROOM_AGENT_TASKS.find((item) => item.role === "Operator");
  if (!spec) return "";
  return structuredRoomTask(spec, goal);
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
  const workspaceId = state.identity?.workspaceId;
  if (workspaceId) {
    const hits = await api.searchMembers(workspaceId, role).catch(() => []);
    const exact = hits.find(
      (hit) => hit.kind === "agent" && hit.displayName.toLowerCase() === role.toLowerCase(),
    );
    if (exact) return exact.id;
    const named = hits.find((hit) => hit.kind === "agent");
    if (named) return named.id;
  }
  const cached = Object.values(state.directory).find(
    (entry) =>
      entry.kind === "agent" && entry.displayName.toLowerCase().includes(role.toLowerCase()),
  );
  return cached?.id ?? null;
}

async function launchTeamRoomRun(
  state: AppState,
  goal: string,
): Promise<EverydayRoomLaunchResult> {
  const channelId = state.activeChannelId;
  if (!channelId) throw new Error("Open a workspace channel before starting the iMessage room.");
  const started = await startCanonicalRoomMessage(channelId, goal);
  const workspaceId = state.identity?.workspaceId;
  if (workspaceId) {
    await api.department.seed(workspaceId, { welcomeTasks: false }).catch(() => undefined);
  }
  // #1568: provider-agnostic readiness — the server says which runtime (Claude by default) will
  // execute the run and whether it is connected; every subtask targets THAT harness, never a
  // hardcoded vendor.
  const runtime = await api.getRuntimeStatus();
  if (!runtime.connected) {
    throw new Error(
      "The agent runtime is not connected for this workspace yet. " + runtime.reason,
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
      phase: spec.phase,
      ...(spec.producesArtifacts ? { producesArtifacts: [...spec.producesArtifacts] } : {}),
      ...(spec.requiresArtifacts ? { requiresArtifacts: [...spec.requiresArtifacts] } : {}),
      harness: runtime.selectedHarness,
    });
  }
  if (subtasks.length === 0) {
    throw new Error(
      "No Scout/Quill/Echo/Lens/operator agents were found in this workspace roster yet.",
    );
  }
  const teamRun = await api.launchTeamRun(channelId, subtasks);
  return { ...started, teamRunId: teamRun.teamRunId };
}

async function startCanonicalRoomMessage(
  channelId: string,
  goal: string,
): Promise<EverydayRoomLaunchResult & { message: Message }> {
  try {
    const relay = await api.startIMessageRoom(channelId, goal);
    if ((relay.status === "sent" || relay.status === "queued") && relay.message) {
      return {
        message: relay.message,
        notices:
          relay.status === "queued"
            ? ["iMessage queued the room start; agent updates will mirror as the relay drains."]
            : [],
      };
    }
  } catch {
    // The web room is the source of truth. A missing Messages relay must not stop the owner from
    // briefing the team; verified external bridges mirror from the normal channel delivery path.
  }

  const message = await api.postMessage(channelId, goal);
  return {
    message,
    notices: [
      "Team started in the web room. iMessage, WhatsApp, and Telegram mirror the thread only after their verified bridge is connected.",
    ],
  };
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
  dashboardOnly = false,
  theme = "public",
}: { dashboardFirst?: boolean; dashboardOnly?: boolean; theme?: EverydayShellTheme } = {}): React.JSX.Element {
  // #1532: the everyday room is a warm, homepage-light surface — not the near-black app chrome. Stamp the
  // public light theme on <body> (so the page background matches rgb(246,241,231), never the reload-dark
  // rgb(13,13,17)); the shell itself flips warm via the `public` theme below.
  usePublicLightTheme();
  const state = useAppState();
  const store = useStore();
  useLiveChannelMessages(state.activeChannelId ?? null);
  const mission = useLiveMissionControl(state.identity?.workspaceId);
  const [connections, setConnections] = useState<readonly ConnectionView[] | null>(null);
  const [imessageStatus, setIMessageStatus] = useState<IMessageStatusResponse | null>(null);
  const [firstRun, setFirstRun] = useState<FirstRunReceiptDto | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [fleetPaused, setFleetPaused] = useState(false);

  useEffect(() => {
    const active = (mission.data?.sessions ?? [])
      .filter((session) => session.status === "running" || session.status === "provisioning")
      .map((session) => ({
        id: session.id,
        channelId: session.channelId,
        agentMemberId: session.agentMemberId,
        status: session.status,
        agentStatus: session.agentStatus,
      }));
    store.setLiveSessions(active);
  }, [mission.data, store]);

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

  async function refreshRuntimeStatus(): Promise<void> {
    setRuntimeStatus(await api.getRuntimeStatus());
  }

  useEffect(() => {
    if (state.phase !== "ready") return;
    // #1531: bootstrap already loads the pending approval queue (loadWorkspace → refreshPending) and realtime
    // keeps it live, so the everyday surface must NOT re-fire `/approvals?status=pending` on mount — that was a
    // duplicate boot request. Only fetch here if another surface left the queue on a non-pending filter.
    if (state.approvals.status !== "pending") void store.loadApprovals("pending");
    void refreshConnections().catch(() => setConnections(null));
    void refreshIMessageStatus().catch(() => setIMessageStatus(null));
    void refreshFirstRun().catch(() => setFirstRun(null));
    void refreshRuntimeStatus().catch(() => setRuntimeStatus(null));
    // NOTE: state.approvals.status is read as a boot-time guard, not subscribed to — this effect stays keyed on
    // workspace/phase (realtime + the console view own live approval-filter changes), matching the sibling calls.
  }, [state.phase, state.identity?.workspaceId, store]);

  // Wire every connector "connect" click to a real setup/OAuth flow (#1551). This never silently no-ops:
  // it works from the live connections list AND from the fallback catalog (when the list failed to load),
  // hands OAuth providers off to their authorize screen, records interest for not-live channels, and turns
  // on one-click channels — always returning an outcome the shell renders as visible feedback.
  async function connect(id: string): Promise<EverydayConnectorConnectResult> {
    const connection = connections?.find((item) => item.id === id) ?? null;
    // The fallback catalog carries the same ids/statuses, so a click still knows what it is doing offline.
    const fallback = connection ? null : defaultConnectors().find((item) => item.id === id) ?? null;
    if (connection?.connected) return { outcome: "noop" };

    // Telegram has a dedicated bot deep-link rather than an OAuth consent screen.
    if (id === "telegram_room") {
      navigateToTelegramStart(await api.startTelegramConnection());
      return { outcome: "redirecting" };
    }

    // iMessage's real setup is the recipient panel rendered directly above the catalog.
    if (id === "imessage") return { outcome: "imessage" };

    // Not live yet: record interest so the click has an honest next step instead of a dead stop.
    const comingSoon = connection ? connection.status === "coming_soon" : fallback?.status === "coming_soon";
    if (comingSoon) {
      await api.joinConnectionWaitlist(id).catch(() => undefined);
      return { outcome: "waitlisted" };
    }

    // Consumer OAuth: park consent, then hand the browser to the provider authorize screen.
    if (connection?.auth === "oauth") {
      const started = await api.startConnectionOAuth(id);
      if (started.status === "coming_soon") {
        await api.joinConnectionWaitlist(id).catch(() => undefined);
        return { outcome: "waitlisted" };
      }
      if (started.authorizePath) {
        window.location.assign(started.authorizePath);
        return { outcome: "redirecting" };
      }
      await refreshConnections();
      return { outcome: "pending" };
    }

    // One-click live channel (email, website, web room, social) — turn it on now, then re-read state.
    await api.enableConnection(id);
    await refreshConnections();
    return { outcome: "connected" };
  }

  const data = liveEverydayDataFromState(state, firstRun, runtimeStatus);
  const showCmoSummary = shouldShowCmoSummary({
    flagOn: CMO_SUMMARY_ENABLED,
    ownerWorkspaceId: CMO_SUMMARY_OWNER_WORKSPACE_ID,
    workspaceId: state.identity?.workspaceId,
  });
  return (
    <EverydayShell
      data={{
        ...data,
        fleetPaused,
        connectors: connections
          ? connections.map((connection) => connectorFromConnection(connection, imessageStatus))
          : data.connectors,
      }}
      onConnectorConnect={(id) => connect(id)}
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
      onStartRoom={async (goal) => {
        const result = await launchTeamRoomRun(state, goal);
        if (state.activeChannelId) await store.refreshChannelMessages(state.activeChannelId);
        return result;
      }}
      onEmergencyStop={async () => {
        const workspaceId = state.identity?.workspaceId;
        if (!workspaceId) throw new Error("No signed-in workspace is ready for the fleet switch.");
        const result = await api.setKillSwitch(workspaceId, true);
        setFleetPaused(result.killSwitch);
      }}
      onResumeFleet={async () => {
        const workspaceId = state.identity?.workspaceId;
        if (!workspaceId) throw new Error("No signed-in workspace is ready for the fleet switch.");
        const result = await api.setKillSwitch(workspaceId, false);
        setFleetPaused(result.killSwitch);
      }}
      operatorPacketForGoal={codexOperatorPacket}
      dashboardFirst={dashboardFirst}
      dashboardOnly={dashboardOnly}
      theme={theme}
      showCmoSummary={showCmoSummary}
    />
  );
}
