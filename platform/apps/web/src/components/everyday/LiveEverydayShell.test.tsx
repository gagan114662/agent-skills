import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ApprovalRequestDto } from "@reload/shared";
import type { ConnectionView } from "../../api/types.js";
import {
  LiveEverydayShell,
  liveEverydayDataFromState,
  withLiveRoomSessions,
} from "./LiveEverydayShell.js";
import { EVERYDAY } from "../../brand.js";
import { api } from "../../api/client.js";
import { makeMessage, renderWithStore } from "../../test/utils.js";
import { FIRST_RUN_RECEIPT_KEY } from "../onboarding/first-run-receipt.js";
import { emptyEverydayData } from "./everyday-data.js";
import type { AppState } from "../../store/store.js";

function approval(over: Partial<ApprovalRequestDto> = {}): ApprovalRequestDto {
  return {
    id: "apr-live",
    workspaceId: "w1",
    requesterMemberId: "ag1",
    actionType: "external.send",
    payload: { body: "Hi Morgan — here's the real follow-up draft." },
    amount: null,
    summary: "Send follow-up to Morgan",
    status: "pending",
    reason: null,
    decidedByMemberId: null,
    decidedAt: null,
    expiresAt: null,
    result: null,
    error: null,
    createdAt: "2026-06-25T10:00:00.000Z",
    updatedAt: "2026-06-25T10:00:00.000Z",
    ...over,
  };
}

function customerConnection(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: "email",
    label: "Email",
    summary: "email, replies, and follow-up receipts.",
    provider: "email",
    kind: "email",
    audience: "customer",
    auth: "one_click",
    status: "available",
    statusReason: null,
    capabilities: ["send_email"],
    oauthScopes: [],
    consentStatus: "none",
    providerStatus: "unproven",
    lastProofAt: null,
    lastProofReceipt: null,
    failureReason: null,
    connected: false,
    ...over,
  };
}

function connectorsRegion(): HTMLElement {
  return screen.getByRole("region", { name: EVERYDAY.connectors.heading });
}

describe("LiveEverydayShell (#1181)", () => {
  beforeEach(() => {
    vi.spyOn(api, "getFirstRunReceipt").mockResolvedValue({ firstRun: null });
    vi.spyOn(api, "recordFirstRunReceipt").mockResolvedValue({ firstRun: null });
    vi.spyOn(api, "getCodexStatus").mockResolvedValue({
      connected: true,
      reason: "",
      selectedHarness: "codex",
      userAuthenticated: true,
      workspaceAuthenticated: true,
      runtimeAuth: "signed_in_subscription",
      fallback: "none",
      apiKeySatisfies: false,
    });
    vi.spyOn(api.department, "seed").mockResolvedValue({
      channels: [],
      agents: [],
      welcomeTasks: [],
    });
    vi.spyOn(api.department, "brief").mockResolvedValue({
      lead: "scout",
      department: "growth",
      channelId: "c1",
      messageId: "m-brief",
      launched: [],
      connectPrompted: [],
    });
    vi.spyOn(api, "getIMessageStatus").mockResolvedValue({
      enabled: true,
      configured: false,
      dryRun: false,
      recipientSource: "none",
      requiresVerification: false,
      maxChars: 2000,
      memberRecipient: null,
    });
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("renders signed-in workspace state instead of the Northwind/Dana seed", async () => {
    const { store } = renderWithStore(<LiveEverydayShell />, {
      messages: [
        makeMessage({
          id: "m-live",
          authorMemberId: "ag1",
          body: "Scout found a real Search Console issue.",
        }),
      ],
      approvals: [approval()],
    });

    await act(async () => {
      await store.bootstrap();
    });

    expect(
      (await screen.findAllByText("Scout found a real Search Console issue.")).length,
    ).toBeGreaterThan(0);
    expect((await screen.findAllByText("Send follow-up to Morgan")).length).toBeGreaterThan(0);
    expect(screen.getByText("Hi Morgan — here's the real follow-up draft.")).toBeInTheDocument();
    expect(screen.queryByText(/northwind/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/dana@northwind\.co/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cus_northwind_trial/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ipop-dana-northwind-trial/i)).not.toBeInTheDocument();
  });

  it("uses honest empty states when the workspace has no live work yet", async () => {
    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

    await act(async () => {
      await store.bootstrap();
    });

    expect(await screen.findByText(/build ipop like Tomo/i)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: EVERYDAY.room.heading })).toBeInTheDocument();
    expect(screen.getByText(EVERYDAY.approvals.empty)).toBeInTheDocument();
    expect(screen.getByText(EVERYDAY.transparency.empty)).toBeInTheDocument();
    expect(screen.getAllByText("$0").length).toBeGreaterThan(0);
    expect(await screen.findByText("signed-in team engine is connected")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Northwind/i)).not.toBeInTheDocument());
  });

  it("surfaces missing Codex subscription auth in the live readiness dashboard", async () => {
    vi.mocked(api.getCodexStatus).mockResolvedValue({
      connected: false,
      reason: "Codex subscription auth is not connected for this workspace yet.",
      selectedHarness: "codex",
      userAuthenticated: true,
      workspaceAuthenticated: true,
      runtimeAuth: "missing",
      fallback: "none",
      apiKeySatisfies: false,
    });
    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

    await act(async () => {
      await store.bootstrap();
    });

    expect(
      await screen.findByText("Codex subscription auth is not connected for this workspace yet."),
    ).toBeInTheDocument();
    expect(screen.getByText("auth").closest("li")).toHaveAttribute("data-status", "blocked");
  });

  it("projects current-channel live marketing agents into the signed-in room data", () => {
    const data = emptyEverydayData("Ada");
    const projected = withLiveRoomSessions(data, {
      activeChannelId: "c1",
      directory: {
        "ag-scout": { id: "ag-scout", kind: "agent", displayName: "Scout" },
        "ag-quill": { id: "ag-quill", kind: "agent", displayName: "Quill" },
        "ag-codex": { id: "ag-codex", kind: "agent", displayName: "Codex operator" },
      },
      liveSessions: [
        {
          id: "sess-scout",
          channelId: "c1",
          agentMemberId: "ag-scout",
          status: "running",
          agentStatus: "thinking",
        },
        {
          id: "sess-quill",
          channelId: "c1",
          agentMemberId: "ag-quill",
          status: "running",
          agentStatus: "drafting",
        },
        {
          id: "sess-codex",
          channelId: "c1",
          agentMemberId: "ag-codex",
          status: "running",
          agentStatus: "handoff",
        },
      ],
    } as unknown as AppState);

    expect(projected.room.find((lane) => lane.agent === "Scout")?.status).toBe("working");
    expect(projected.room.find((lane) => lane.agent === "Scout")?.task).toContain(
      "Scout is thinking through the next marketing move",
    );
    expect(projected.room.find((lane) => lane.agent === "Quill")?.task).toContain(
      "Quill is drafting work for the room",
    );
    expect(projected.room.find((lane) => lane.agent === "Operator")?.task).toContain(
      "Operator is handing work to the next lane",
    );
    expect(projected.marketingBrief?.headline).toContain("Scout working, Quill working, Operator working");
  });

  it("does not mistake an idle room for an engaged kill switch", () => {
    const data = liveEverydayDataFromState(
      {
        activeChannelId: "c1",
        directory: {},
        liveSessions: [],
        messagesByChannel: {},
        approvals: { requests: [] },
        identity: { memberId: "m1", workspaceId: "ws1", displayName: "Ada" },
      } as unknown as AppState,
    );

    expect(data.fleetPaused).toBe(false);
  });

  it("opens the Telegram bot start-link flow from the live everyday connector", async () => {
    const originalLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign },
    });
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [
        {
          id: "telegram_room",
          label: "Connect Telegram room",
          summary: "Connect your Telegram chat, then mirror the agent room with signed webhook replies back into ipop.",
          provider: "telegram",
          kind: "sms",
          audience: "customer",
          auth: "one_click",
          status: "available",
          statusReason: null,
          capabilities: ["work_visibility", "mobile_messaging", "agent_room_visibility", "inbound_replies"],
          oauthScopes: [],
          consentStatus: "none",
          providerStatus: "unproven",
          lastProofAt: null,
          lastProofReceipt: null,
          failureReason: null,
          connected: false,
        },
      ],
      canManageInternal: false,
    });
    vi.spyOn(api, "startTelegramConnection").mockResolvedValue({
      status: "pending_telegram_start",
      botUsername: "ipopmarketingbot",
      startParam: "telegram-start-code",
      startCommand: "/start telegram-start-code",
      startUrl: "https://t.me/ipopmarketingbot?start=telegram-start-code",
      expiresAtMs: 1_800_000_000_000,
    });
    const enableConnection = vi.spyOn(api, "enableConnection").mockResolvedValue({
      connections: [],
      canManageInternal: false,
    });

    try {
      const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

      await act(async () => {
        await store.bootstrap();
      });

      expect(await screen.findByText("Telegram room")).toBeInTheDocument();
      fireEvent.click(await screen.findByRole("button", { name: "connect" }));

      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith("https://t.me/ipopmarketingbot?start=telegram-start-code"),
      );
      expect(api.startTelegramConnection).toHaveBeenCalledTimes(1);
      expect(enableConnection).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("hands a consumer-OAuth connector off to the provider authorize screen (#1551)", async () => {
    const originalLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign },
    });
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [
        customerConnection({
          id: "x",
          label: "X",
          provider: "x",
          kind: "social",
          auth: "oauth",
          capabilities: ["post_social"],
          summary: "research public threads and draft owner-approved replies.",
        }),
      ],
      canManageInternal: false,
    });
    const startOAuth = vi.spyOn(api, "startConnectionOAuth").mockResolvedValue({
      status: "pending_approval",
      requestId: "req-x",
      authorizePath: "/me/connections/x/oauth/authorize",
      provider: "x",
      scopes: ["post_social"],
      message: "Consent recorded.",
    });

    try {
      const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });
      await act(async () => {
        await store.bootstrap();
      });

      expect(await screen.findByText("X")).toBeInTheDocument();
      fireEvent.click(within(connectorsRegion()).getByRole("button", { name: "connect" }));

      await waitFor(() => expect(assign).toHaveBeenCalledWith("/me/connections/x/oauth/authorize"));
      expect(startOAuth).toHaveBeenCalledWith("x");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("turns on a one-click channel and shows visible feedback (#1551)", async () => {
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [customerConnection()],
      canManageInternal: false,
    });
    const enableConnection = vi.spyOn(api, "enableConnection").mockResolvedValue({
      connections: [customerConnection({ connected: true, providerStatus: "healthy" })],
      canManageInternal: false,
    });

    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });
    await act(async () => {
      await store.bootstrap();
    });

    fireEvent.click(within(connectorsRegion()).getByRole("button", { name: "connect" }));

    await waitFor(() => expect(enableConnection).toHaveBeenCalledWith("email"));
    expect(await within(connectorsRegion()).findByRole("status")).toBeInTheDocument();
  });

  it("records interest for a not-live connector instead of dying silently (#1551)", async () => {
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [
        customerConnection({
          id: "linkedin",
          label: "LinkedIn",
          provider: "linkedin",
          auth: "oauth",
          status: "coming_soon",
          capabilities: ["post_social"],
          summary: "native LinkedIn posting is not live yet.",
        }),
      ],
      canManageInternal: false,
    });
    const waitlist = vi.spyOn(api, "joinConnectionWaitlist").mockResolvedValue(undefined);

    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });
    await act(async () => {
      await store.bootstrap();
    });

    fireEvent.click(within(connectorsRegion()).getByRole("button", { name: "notify me" }));

    await waitFor(() => expect(waitlist).toHaveBeenCalledWith("linkedin"));
    expect(await within(connectorsRegion()).findByRole("status")).toBeInTheDocument();
  });

  it("still fires a real connect call from the fallback catalog when connections fail to load (#1551)", async () => {
    vi.spyOn(api, "getConnections").mockRejectedValue(new Error("offline"));
    const enableConnection = vi.spyOn(api, "enableConnection").mockResolvedValue({
      connections: [],
      canManageInternal: false,
    });

    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });
    await act(async () => {
      await store.bootstrap();
    });

    // The default catalog is shown when the live connections list is unavailable; its buttons must not no-op.
    const emailButton = within(connectorsRegion())
      .getAllByRole("button", { name: "connect" })
      .find((button) => button.closest(".everyday-connector")?.textContent?.includes("Email"));
    expect(emailButton).toBeDefined();
    fireEvent.click(emailButton!);

    await waitFor(() => expect(enableConnection).toHaveBeenCalledWith("email"));
  });

  it("surfaces Mac relay heartbeat plus outbound and inbound iMessage proof (#1341)", async () => {
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [
        {
          id: "imessage",
          label: "iMessage",
          summary: "Production Messages bridge",
          provider: "apple",
          kind: "chat",
          audience: "customer",
          auth: "paste_internal",
          status: "blocked",
          statusReason: null,
          capabilities: ["work_visibility", "imessage_room"],
          oauthScopes: [],
          consentStatus: "none",
          providerStatus: "unproven",
          lastProofAt: null,
          lastProofReceipt: null,
          failureReason: null,
          connected: false,
        },
      ],
      canManageInternal: false,
    });
    vi.mocked(api.getIMessageStatus).mockResolvedValue({
      enabled: true,
      configured: true,
      dryRun: false,
      recipient: "gagan@example.com",
      recipientSource: "member_verified",
      requiresVerification: false,
      maxChars: 2000,
      memberRecipient: {
        recipient: "gagan@example.com",
        serviceName: "iMessage",
        verified: true,
        verifiedAt: "2026-06-28T05:00:00.000Z",
      },
      relay: {
        mode: "queued",
        webhookConfigured: true,
        directReady: false,
        queueReady: true,
        heartbeatReady: true,
        roomStartReady: true,
        loopbackReady: true,
        roomReady: true,
        roomReadyReason: "verified recipient, outbound room send, and inbound iMessage reply are correlated",
        jobSummary: {
          pending: 0,
          claimed: 0,
          sent: 3,
          failed: 0,
          lastOutboundAt: "2026-06-28T05:02:00.000Z",
          lastSentAt: "2026-06-28T05:02:00.000Z",
          lastFailedAt: null,
          lastError: null,
        },
      },
      relayHeartbeat: {
        relayId: "gagan-mac",
        host: "Gagans-MacBook-Pro",
        version: "dev-1341",
        checkedInAt: "2026-06-28T05:01:00.000Z",
        messagesAccess: "ok",
        messagesDbAccess: "ok",
        active: true,
      },
      lastRelayJob: {
        id: "job-1",
        workspaceId: "w1",
        memberId: "m1",
        channelId: "c1",
        messageId: "root-1",
        purpose: "room",
        recipient: "gagan@example.com",
        serviceName: "iMessage",
        text: "room receipt",
        receipt: "imessage:c1:root-1",
        status: "sent",
        lockedBy: null,
        lockedUntil: null,
        sentAt: "2026-06-28T05:02:00.000Z",
        failedAt: null,
        error: null,
        createdAt: "2026-06-28T05:01:30.000Z",
        updatedAt: "2026-06-28T05:02:00.000Z",
      },
      lastInboundReceipt: {
        id: "inbound-1",
        workspaceId: "w1",
        memberId: "m1",
        channelId: "c1",
        messageId: "reply-1",
        replyToMessageId: "root-1",
        sender: "gagan@example.com",
        receipt: "imessage:c1:root-1",
        text: "tell Scout to compare competitors",
        createdAt: "2026-06-28T05:03:00.000Z",
      },
    });
    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

    await act(async () => {
      await store.bootstrap();
    });

    expect(await screen.findByText("Mac relay host active with Messages send and reply access: Gagans-MacBook-Pro")).toBeInTheDocument();
    expect(screen.getByText("queue")).toBeInTheDocument();
    expect(screen.getByText("Mac host")).toBeInTheDocument();
    expect(screen.getByText("reply loop")).toBeInTheDocument();
    expect(screen.getByText("proven")).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.getByText("last iMessage relay sent: imessage:c1:root-1")).toBeInTheDocument();
    expect(screen.getByText("last inbound iMessage reply landed: imessage:c1:root-1")).toBeInTheDocument();
    expect(screen.getByText(EVERYDAY.room.imessageNotes.ready)).toBeInTheDocument();
    expect(screen.queryByText(/Until the native relay is live/i)).not.toBeInTheDocument();
  });

  it("does not call iMessage verified until a reply loop lands back in the room", async () => {
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [],
      canManageInternal: false,
    });
    vi.mocked(api.getIMessageStatus).mockResolvedValue({
      enabled: true,
      configured: true,
      dryRun: false,
      recipient: "gagan@example.com",
      recipientSource: "member_verified",
      requiresVerification: false,
      maxChars: 2000,
      memberRecipient: {
        recipient: "gagan@example.com",
        serviceName: "iMessage",
        verified: true,
        verifiedAt: "2026-06-28T05:00:00.000Z",
      },
      relay: {
        mode: "queued",
        webhookConfigured: true,
        directReady: false,
        queueReady: true,
        heartbeatReady: true,
        roomStartReady: true,
        loopbackReady: false,
        roomReady: false,
        roomReadyReason: "waiting for an inbound iMessage reply receipt before claiming the room works end-to-end",
        jobSummary: {
          pending: 1,
          claimed: 0,
          sent: 1,
          failed: 0,
          lastOutboundAt: "2026-06-28T05:02:00.000Z",
          lastSentAt: "2026-06-28T05:02:00.000Z",
          lastFailedAt: null,
          lastError: null,
        },
      },
      relayHeartbeat: {
        relayId: "gagan-mac",
        host: "Gagans-MacBook-Pro",
        version: "dev-1341",
        checkedInAt: "2026-06-28T05:01:00.000Z",
        messagesAccess: "ok",
        messagesDbAccess: "ok",
        active: true,
      },
      lastInboundReceipt: null,
    });
    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

    await act(async () => {
      await store.bootstrap();
    });

    expect(await screen.findByText(EVERYDAY.connectors.imessage.loopPending)).toBeInTheDocument();
    expect(screen.getByText(EVERYDAY.connectors.imessage.loopPendingDetail)).toBeInTheDocument();
    expect(screen.getByText("reply loop")).toBeInTheDocument();
    expect(screen.getAllByText("waiting").length).toBeGreaterThan(0);
    expect(screen.queryByText(EVERYDAY.connectors.imessage.verified)).not.toBeInTheDocument();
    expect(screen.getByText(EVERYDAY.room.imessageNotes.replyNeeded)).toBeInTheDocument();
  });

  it("does not mark iMessage connected when the Mac relay cannot access Messages", async () => {
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [
        {
          id: "imessage",
          label: "iMessage",
          summary: "Production Messages bridge",
          provider: "apple",
          kind: "chat",
          audience: "customer",
          auth: "paste_internal",
          status: "available",
          statusReason: null,
          capabilities: ["work_visibility", "imessage_room"],
          oauthScopes: [],
          consentStatus: "recorded",
          providerStatus: "healthy",
          lastProofAt: 123,
          lastProofReceipt: "imessage:test",
          failureReason: null,
          connected: true,
        },
      ],
      canManageInternal: false,
    });
    vi.mocked(api.getIMessageStatus).mockResolvedValue({
      enabled: true,
      configured: true,
      dryRun: false,
      recipient: "gagan@example.com",
      recipientSource: "member_verified",
      requiresVerification: false,
      maxChars: 2000,
      memberRecipient: {
        recipient: "gagan@example.com",
        serviceName: "iMessage",
        verified: true,
        verifiedAt: "2026-06-28T05:00:00.000Z",
      },
      relayHeartbeat: {
        relayId: "gagan-mac",
        host: "Gagans-MacBook-Pro",
        version: "dev-1341",
        checkedInAt: "2026-06-28T05:01:00.000Z",
        messagesAccess: "failed",
        messagesDbAccess: "ok",
        active: true,
      },
    });
    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

    await act(async () => {
      await store.bootstrap();
    });

    expect(await screen.findByText(EVERYDAY.connectors.imessage.blocked)).toBeInTheDocument();
    expect(screen.getAllByText(/recipient verified; relay cannot send through Messages yet/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Mac relay host active, but Messages send access is blocked: Gagans-MacBook-Pro")).toBeInTheDocument();
    expect(screen.queryByText(/live relay verified for gagan@example.com/i)).not.toBeInTheDocument();
  });

  it("posts the brief before blocking agent launch when the signed-in team engine is not connected", async () => {
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [],
      canManageInternal: false,
    });
    vi.spyOn(api, "getCodexStatus").mockResolvedValue({
      connected: false,
      reason: "The team engine is not connected for this session.",
      selectedHarness: "codex",
      userAuthenticated: true,
      workspaceAuthenticated: true,
      runtimeAuth: "missing",
      fallback: "none",
      apiKeySatisfies: false,
    });
    vi.spyOn(api, "startIMessageRoom").mockResolvedValue({
      status: "not_configured",
      dryRun: false,
      error: "iMessage relay is not configured for this workspace yet.",
    });
    const postMessage = vi
      .spyOn(api, "postMessage")
      .mockResolvedValue(makeMessage({ id: "web-room", channelId: "c1", body: "build ipop.ai" }));
    const launchTeamRun = vi.spyOn(api, "launchTeamRun");
    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

    await act(async () => {
      await store.bootstrap();
    });

    fireEvent.change(await screen.findByRole("textbox", { name: EVERYDAY.prompt }), {
      target: { value: "build ipop.ai" },
    });
    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.composerSend }));

    expect(
      await screen.findByText(
        "The team engine is not connected to your signed-in subscription yet. Connect it before starting the agent room.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith("c1", "build ipop.ai"));
    expect(screen.getAllByText("build ipop.ai").length).toBeGreaterThan(0);
    expect(launchTeamRun).not.toHaveBeenCalled();
  });

  it("falls back to the canonical web room and still launches agents when iMessage is not configured (#1466)", async () => {
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [],
      canManageInternal: false,
    });
    vi.spyOn(api, "getCodexStatus").mockResolvedValue({
      connected: true,
      reason: "",
      selectedHarness: "codex",
      userAuthenticated: true,
      workspaceAuthenticated: true,
      runtimeAuth: "signed_in_subscription",
      fallback: "none",
      apiKeySatisfies: false,
    });
    vi.spyOn(api, "startIMessageRoom").mockResolvedValue({
      status: "not_configured",
      dryRun: false,
      receipt: "imessage:c1:m1",
      message: makeMessage({ id: "m1", channelId: "c1", body: "build ipop.ai" }),
      error: "iMessage relay is not configured for this workspace yet.",
    });
    const postMessage = vi
      .spyOn(api, "postMessage")
      .mockResolvedValue(makeMessage({ id: "web-room", channelId: "c1", body: "build ipop.ai" }));
    vi.spyOn(api, "searchMembers").mockImplementation(async (_workspaceId, q) => [
      { id: "ag-" + q.toLowerCase(), kind: "agent", displayName: q },
    ]);
    const launchTeamRun = vi.spyOn(api, "launchTeamRun").mockResolvedValue({
      teamRunId: "team-1",
      subtaskCount: 5,
      subtasks: [],
    });
    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

    await act(async () => {
      await store.bootstrap();
    });

    fireEvent.change(await screen.findByRole("textbox", { name: EVERYDAY.prompt }), {
      target: { value: "build ipop.ai" },
    });
    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.composerSend }));

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith("c1", "build ipop.ai"));
    await waitFor(() => expect(launchTeamRun).toHaveBeenCalled());
    expect(await screen.findByText(/Team started in the web room/i)).toBeInTheDocument();
    expect(screen.getByText(/iMessage, WhatsApp, and Telegram mirror/i)).toBeInTheDocument();
    expect(screen.queryByText("iMessage relay is not configured for this workspace yet.")).not.toBeInTheDocument();
  });

  it("uses the web room instead of blocking when iMessage is only dry-run (#1466)", async () => {
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [],
      canManageInternal: false,
    });
    vi.spyOn(api, "getCodexStatus").mockResolvedValue({
      connected: true,
      reason: "",
      selectedHarness: "codex",
      userAuthenticated: true,
      workspaceAuthenticated: true,
      runtimeAuth: "signed_in_subscription",
      fallback: "none",
      apiKeySatisfies: false,
    });
    vi.spyOn(api, "startIMessageRoom").mockResolvedValue({
      status: "dry_run",
      dryRun: true,
      recipient: "gagan@example.com",
      error: "iMessage relay is still in dry-run mode; no real Messages room was started.",
    });
    const postMessage = vi
      .spyOn(api, "postMessage")
      .mockResolvedValue(makeMessage({ id: "web-room", channelId: "c1", body: "build ipop.ai" }));
    vi.spyOn(api, "searchMembers").mockImplementation(async (_workspaceId, q) => [
      { id: "ag-" + q.toLowerCase(), kind: "agent", displayName: q },
    ]);
    const launchTeamRun = vi.spyOn(api, "launchTeamRun").mockResolvedValue({
      teamRunId: "team-1",
      subtaskCount: 5,
      subtasks: [],
    });
    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

    await act(async () => {
      await store.bootstrap();
    });

    fireEvent.change(await screen.findByRole("textbox", { name: EVERYDAY.prompt }), {
      target: { value: "build ipop.ai" },
    });
    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.composerSend }));

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith("c1", "build ipop.ai"));
    await waitFor(() => expect(launchTeamRun).toHaveBeenCalled());
    expect(await screen.findByText(/Team started in the web room/i)).toBeInTheDocument();
    expect(screen.queryByText("iMessage relay is still in dry-run mode; no real Messages room was started.")).not.toBeInTheDocument();
  });

  it("launches every room agent with the shared prompt structure and a Codex operator packet (#1265)", async () => {
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [],
      canManageInternal: false,
    });
    vi.spyOn(api, "getCodexStatus").mockResolvedValue({
      connected: true,
      reason: "",
      selectedHarness: "codex",
      userAuthenticated: true,
      workspaceAuthenticated: true,
      runtimeAuth: "signed_in_subscription",
      fallback: "none",
      apiKeySatisfies: false,
    });
    vi.spyOn(api, "startIMessageRoom").mockResolvedValue({
      status: "sent",
      dryRun: false,
      receipt: "imessage:c1:room",
      message: makeMessage({ id: "room", channelId: "c1", body: "grow ipop.ai" }),
    });
    vi.spyOn(api, "searchMembers").mockImplementation(async (_workspaceId, q) => [
      { id: "ag-" + q.toLowerCase(), kind: "agent", displayName: q },
    ]);
    const launchTeamRun = vi.spyOn(api, "launchTeamRun").mockResolvedValue({
      teamRunId: "team-1",
      subtaskCount: 5,
      subtasks: [],
    });
    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

    await act(async () => {
      await store.bootstrap();
    });

    fireEvent.change(await screen.findByRole("textbox", { name: EVERYDAY.prompt }), {
      target: { value: "grow ipop.ai" },
    });
    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.composerSend }));

    await waitFor(() => expect(launchTeamRun).toHaveBeenCalled());
    const [channelId, subtasks] = launchTeamRun.mock.calls[0]!;
    expect(channelId).toBe("c1");
    expect(subtasks).toHaveLength(5);
    expect(subtasks.every((subtask) => subtask.harness === "codex")).toBe(true);
    const quill = subtasks.find((subtask) => subtask.branch.startsWith("ipop-quill-"));
    const echo = subtasks.find((subtask) => subtask.branch.startsWith("ipop-echo-"));
    const lens = subtasks.find((subtask) => subtask.branch.startsWith("ipop-lens-"));
    const scout = subtasks.find((subtask) => subtask.branch.startsWith("ipop-scout-"));
    expect(scout?.phase).toBe(1);
    expect(scout?.producesArtifacts).toEqual(["scout_research", "brand_voice"]);
    expect(quill?.phase).toBe(2);
    expect(quill?.requiresArtifacts).toEqual(["scout_research", "brand_voice"]);
    expect(quill?.producesArtifacts).toEqual(["draft_set"]);
    expect(lens?.phase).toBe(3);
    expect(lens?.requiresArtifacts).toEqual(["scout_research", "brand_voice", "draft_set"]);
    expect(lens?.producesArtifacts).toEqual(["lens_review"]);
    expect(echo?.phase).toBe(4);
    expect(echo?.requiresArtifacts).toEqual(["scout_research", "brand_voice", "draft_set", "lens_review"]);
    expect(quill?.task).toContain("You own the drafts");
    expect(quill?.task).toContain("brand_voice");
    expect(quill?.task).toContain("Produce named, approval-ready draft assets");
    expect(quill?.task).toContain("Produce the required draft_set artifact");
    expect(lens?.task).toContain("produce the required lens_review artifact");
    expect(lens?.task).toContain("specificity to business");
    expect(lens?.task).toContain("If a required draft is missing");
    for (const subtask of subtasks) {
      expect(subtask.task).toContain("1. Task context");
      expect(subtask.task).toContain("2. Tone context");
      expect(subtask.task).toContain("3. Background data, documents, and images");
      expect(subtask.task).toContain("4. Detailed task description & rules");
      expect(subtask.task).toContain("5. Examples");
      expect(subtask.task).toContain("6. Conversation history");
      expect(subtask.task).toContain("7. Immediate task description or request");
      expect(subtask.task).toContain("8. Thinking step by step / take a deep breath");
      expect(subtask.task).toContain("9. Output formatting");
      expect(subtask.task).toContain("10. Prefilled response (if any)");
      expect(subtask.task).toContain("grow ipop.ai");
      expect(subtask.task).toContain("Do real marketing work");
      expect(subtask.task).toContain("Do not send, publish, spend");
    }
    const operator = subtasks.find((subtask) => subtask.branch.startsWith("ipop-codex-"));
    expect(operator?.task).toContain("codex_work_packet");
    expect(operator?.task).toContain("audit_label: codex_operator_lane");
    expect(operator?.task).toContain("credential_boundary");
    expect(operator?.task).toContain("Return payload schema");
    expect(operator?.task).toContain("pr_or_issue_links");
    expect(await screen.findByText("Operator packet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy packet" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Open packet"));
    expect(screen.getByText(/codex_work_packet/)).toBeInTheDocument();
    expect(screen.getByText(/audit_label: codex_operator_lane/)).toBeInTheDocument();
  });

  it("submits an everyday brief, creates a team run, posts the brief, and renders a named Quill draft artifact (#1536)", async () => {
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [],
      canManageInternal: false,
    });
    vi.spyOn(api, "getCodexStatus").mockResolvedValue({
      connected: true,
      reason: "",
      selectedHarness: "codex",
      userAuthenticated: true,
      workspaceAuthenticated: true,
      runtimeAuth: "signed_in_subscription",
      fallback: "none",
      apiKeySatisfies: false,
    });
    vi.spyOn(api, "startIMessageRoom").mockResolvedValue({
      status: "not_configured",
      dryRun: false,
      error: "iMessage relay is not configured for this workspace yet.",
    });
    const postMessage = vi
      .spyOn(api, "postMessage")
      .mockResolvedValue(makeMessage({ id: "brief-1", channelId: "c1", body: "launch getfoolish.com" }));
    vi.spyOn(api, "searchMembers").mockImplementation(async (_workspaceId, q) => [
      { id: "ag-" + q.toLowerCase(), kind: "agent", displayName: q },
    ]);
    const launchTeamRun = vi.spyOn(api, "launchTeamRun").mockResolvedValue({
      teamRunId: "team-1",
      subtaskCount: 5,
      subtasks: [],
    });
    const draftMessage = makeMessage({
      id: "quill-draft",
      channelId: "c1",
      authorMemberId: "ag-quill",
      body:
        '::team-event:: {"teamRunId":"team-1","subtaskId":"quill","agentMemberId":"ag-quill","kind":"milestone","summary":"draft set ready: foolish launch","branch":"b-quill","createdAt":"2026-07-02T00:00:00.000Z","artifact":{"kind":"draft_set","schemaVersion":1,"drafts":[{"format":"landing_hero","title":"Foolish first-click hero","fields":{"headline":"Find the expensive leak before your next ad dollar","subhead":"Get Foolish turns messy acquisition guesses into one focused next test.","cta":"Find the leak"},"citations":["Scout proof point"]}]}}',
    });
    const { store, rt } = renderWithStore(<LiveEverydayShell />, {
      messages: [],
      members: [
        { id: "me1", kind: "human", displayName: "Ada" },
        { id: "ag-quill", kind: "agent", displayName: "Quill" },
      ],
      approvals: [],
    });

    await act(async () => {
      await store.bootstrap();
    });

    fireEvent.change(await screen.findByRole("textbox", { name: EVERYDAY.prompt }), {
      target: { value: "launch getfoolish.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.composerSend }));

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith("c1", "launch getfoolish.com"));
    await waitFor(() => expect(launchTeamRun).toHaveBeenCalled());
    await screen.findByText("Reading launch getfoolish.com and lining up the first useful marketing moves.");
    act(() => {
      rt.fire({ type: "message", message: draftMessage });
    });
    await waitFor(() =>
      expect(store.getState().messagesByChannel.c1?.some((message) => message.id === "quill-draft")).toBe(true),
    );
    expect(
      liveEverydayDataFromState(store.getState()).thread.some(
        (entry) => entry.kind === "deliverable" && entry.deliverable.title === "Foolish first-click hero",
      ),
    ).toBe(true);
    expect(screen.getAllByText("launch getfoolish.com").length).toBeGreaterThan(0);
    expect(await screen.findByText("Foolish first-click hero")).toBeInTheDocument();
    expect(screen.getByText(/Find the expensive leak before your next ad dollar/i)).toBeInTheDocument();
  });

  it("lets the signed-in user save and verify their iMessage destination before room launch (#1283)", async () => {
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [
        {
          id: "imessage",
          label: "Connect iMessage",
          summary: "Text the team where work happens.",
          provider: "apple",
          kind: "messaging",
          audience: "customer",
          auth: "one_click",
          status: "available",
          capabilities: ["work_visibility", "imessage_room"],
          oauthScopes: [],
          consentStatus: "none",
          providerStatus: "unproven",
          lastProofAt: null,
          lastProofReceipt: null,
          failureReason: null,
          connected: false,
        },
      ],
      canManageInternal: false,
    });
    const getStatus = vi.mocked(api.getIMessageStatus);
    getStatus
      .mockResolvedValueOnce({
        enabled: true,
        configured: false,
        dryRun: false,
        recipientSource: "none",
        requiresVerification: false,
        maxChars: 2000,
        memberRecipient: null,
      })
      .mockResolvedValueOnce({
        enabled: true,
        configured: false,
        dryRun: false,
        recipient: "gagan@example.com",
        recipientSource: "member_pending",
        requiresVerification: true,
        maxChars: 2000,
        memberRecipient: {
          recipient: "gagan@example.com",
          serviceName: null,
          verified: false,
          verifiedAt: null,
        },
      })
      .mockResolvedValue({
        enabled: true,
        configured: true,
        dryRun: false,
        recipient: "gagan@example.com",
        recipientSource: "member_verified",
        requiresVerification: false,
        maxChars: 2000,
        memberRecipient: {
          recipient: "gagan@example.com",
          serviceName: null,
          verified: true,
          verifiedAt: "2026-06-27T06:00:00.000Z",
        },
        relayHeartbeat: {
          relayId: "gagan-mac",
          host: "Gagans-MacBook-Pro",
          version: "dev-1283",
          checkedInAt: "2026-06-27T06:01:00.000Z",
          messagesAccess: "ok",
          messagesDbAccess: "ok",
          active: true,
        },
      });
    const save = vi.spyOn(api, "saveIMessageRecipient").mockResolvedValue({
      status: "pending_verification",
      recipient: "gagan@example.com",
      serviceName: null,
      verified: false,
      message: "Send a test message before using this iMessage destination for the agent room.",
    });
    const test = vi.spyOn(api, "testIMessageRecipient").mockResolvedValue({
      status: "sent",
      dryRun: false,
      recipient: "gagan@example.com",
      memberRecipient: {
        recipient: "gagan@example.com",
        serviceName: null,
        verified: true,
        verifiedAt: "2026-06-27T06:00:00.000Z",
      },
    });
    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

    await act(async () => {
      await store.bootstrap();
    });

    fireEvent.change(await screen.findByLabelText(EVERYDAY.connectors.imessage.label), {
      target: { value: "GAGAN@Example.COM" },
    });
    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.connectors.imessage.save }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ recipient: "GAGAN@Example.COM", serviceName: undefined }),
    );
    expect(await screen.findByText(EVERYDAY.connectors.imessage.pending)).toBeInTheDocument();
    expect(screen.getAllByText(/gagan@example.com/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.connectors.imessage.test }));

    await waitFor(() => expect(test).toHaveBeenCalled());
    expect(await screen.findByText(EVERYDAY.connectors.imessage.loopPending)).toBeInTheDocument();
    expect(screen.queryByText(EVERYDAY.connectors.imessage.verified)).not.toBeInTheDocument();
  });

  it("does not mark iMessage connected when the recipient is verified but the relay is dry-run (#1283)", async () => {
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [
        {
          id: "imessage",
          label: "Connect iMessage",
          summary: "Text the team where work happens.",
          provider: "apple",
          kind: "messaging",
          audience: "customer",
          auth: "one_click",
          status: "available",
          capabilities: ["work_visibility", "imessage_room"],
          oauthScopes: [],
          consentStatus: "recorded",
          providerStatus: "healthy",
          lastProofAt: 123,
          lastProofReceipt: "imessage:test",
          failureReason: null,
          connected: true,
        },
      ],
      canManageInternal: false,
    });
    vi.mocked(api.getIMessageStatus).mockResolvedValue({
      enabled: true,
      configured: true,
      dryRun: true,
      recipient: "gagan@example.com",
      recipientSource: "member_verified",
      requiresVerification: false,
      maxChars: 2000,
      memberRecipient: {
        recipient: "gagan@example.com",
        serviceName: null,
        verified: true,
        verifiedAt: "2026-06-27T06:00:00.000Z",
      },
      lastRelayJob: {
        id: "relay-1",
        workspaceId: "w1",
        memberId: "m1",
        channelId: "c1",
        messageId: "room-1",
        purpose: "room",
        recipient: "gagan@example.com",
        serviceName: null,
        text: "room receipt",
        receipt: "imessage:c1:room-1",
        status: "failed",
        lockedBy: null,
        lockedUntil: null,
        sentAt: null,
        failedAt: "2026-06-27T06:03:00.000Z",
        error: "Apple Messages send failed on the relay host",
        createdAt: "2026-06-27T06:02:00.000Z",
        updatedAt: "2026-06-27T06:03:00.000Z",
      },
      relayHeartbeat: {
        relayId: "gagan-mac",
        host: "Gagans-MacBook-Pro",
        version: "dev-1341",
        checkedInAt: "2026-06-27T06:04:00.000Z",
        messagesAccess: "ok",
        messagesDbAccess: "ok",
        active: true,
      },
    });
    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

    await act(async () => {
      await store.bootstrap();
    });

    expect(await screen.findByText(EVERYDAY.connectors.imessage.blocked)).toBeInTheDocument();
    expect(screen.getAllByText(/recipient verified; relay is dry-run/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Mac relay host active with Messages send and reply access: Gagans-MacBook-Pro/i)).toBeInTheDocument();
    expect(screen.getByText(/last iMessage relay failed: Apple Messages send failed/i)).toBeInTheDocument();
    expect(screen.queryByText(EVERYDAY.connectors.connected)).not.toBeInTheDocument();
    expect(screen.getByText(EVERYDAY.room.imessageNotes.relayBlocked)).toBeInTheDocument();
  });

  it("surfaces a dry-run iMessage test as an error instead of a successful verification (#1283)", async () => {
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [
        {
          id: "imessage",
          label: "Connect iMessage",
          summary: "Text the team where work happens.",
          provider: "apple",
          kind: "messaging",
          audience: "customer",
          auth: "one_click",
          status: "available",
          capabilities: ["work_visibility", "imessage_room"],
          oauthScopes: [],
          consentStatus: "none",
          providerStatus: "unproven",
          lastProofAt: null,
          lastProofReceipt: null,
          failureReason: null,
          connected: false,
        },
      ],
      canManageInternal: false,
    });
    vi.mocked(api.getIMessageStatus).mockResolvedValue({
      enabled: true,
      configured: false,
      dryRun: true,
      recipient: "gagan@example.com",
      recipientSource: "member_pending",
      requiresVerification: true,
      maxChars: 2000,
      memberRecipient: {
        recipient: "gagan@example.com",
        serviceName: null,
        verified: false,
        verifiedAt: null,
      },
    });
    vi.spyOn(api, "testIMessageRecipient").mockResolvedValue({
      status: "dry_run",
      dryRun: true,
      recipient: "gagan@example.com",
      error: "iMessage relay is still in dry-run mode; no real Messages test was sent.",
      memberRecipient: {
        recipient: "gagan@example.com",
        serviceName: null,
        verified: false,
        verifiedAt: null,
      },
    });
    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

    await act(async () => {
      await store.bootstrap();
    });

    fireEvent.click(await screen.findByRole("button", { name: EVERYDAY.connectors.imessage.test }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/dry-run mode/i);
    expect(screen.queryByText(EVERYDAY.connectors.imessage.verified)).not.toBeInTheDocument();
  });

  it("surfaces the persisted first-run receipt as live CMO dashboard proof (#1289)", async () => {
    vi.mocked(api.getFirstRunReceipt).mockResolvedValue({
      firstRun: {
        stage: "agent_result",
        target: "acme.com",
        finding: "your hero buries the offer below the fold.",
        artifactTitle: "site-read receipt",
        artifactSummary: "hero rewrite + launch-week post plan",
        receipt: "send/spend gates active",
        recordedAtMs: Date.UTC(2026, 5, 26, 12, 30),
      },
    });
    const { store } = renderWithStore(<LiveEverydayShell dashboardFirst />, {
      messages: [],
      approvals: [],
    });

    await act(async () => {
      await store.bootstrap();
    });

    expect(
      (await screen.findAllByText("your hero buries the offer below the fold.")).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("recorded first result for acme.com").length).toBeGreaterThan(0);
    expect(screen.queryByText("site-read receipt")).not.toBeInTheDocument();
    expect(screen.getAllByText("Research receipt captured; draft still pending").length).toBeGreaterThan(0);
    expect(screen.getAllByText("waiting for Quill or Echo content").length).toBeGreaterThan(0);
    expect(screen.getAllByText("send/spend gates active").length).toBeGreaterThan(0);
    expect(screen.getByText(EVERYDAY.dashboard.rankedWork)).toBeInTheDocument();
    expect(screen.getByText("first useful marketing result")).toBeInTheDocument();
    expect(screen.getByText("turned a live source read into one owner-reviewable direction")).toBeInTheDocument();
    expect(screen.getByText("external send path")).toBeInTheDocument();
    expect(screen.getByText("blocked until one connector produces a real sent-message receipt")).toBeInTheDocument();
  });

  it("flushes the public first-run handoff once signed in, then clears browser state (#1289)", async () => {
    window.sessionStorage.setItem(
      FIRST_RUN_RECEIPT_KEY,
      JSON.stringify({
        stage: "agent_result",
        target: "acme.com",
        finding: "your hero buries the offer below the fold.",
        artifactTitle: "site-read receipt",
        artifactSummary: "hero rewrite + launch-week post plan",
        receipt: "team mission recorded",
      }),
    );
    const record = vi.mocked(api.recordFirstRunReceipt).mockResolvedValue({
      firstRun: {
        stage: "agent_result",
        target: "acme.com",
        finding: "your hero buries the offer below the fold.",
        artifactTitle: "site-read receipt",
        artifactSummary: "hero rewrite + launch-week post plan",
        receipt: "team mission recorded",
        recordedAtMs: Date.UTC(2026, 5, 26, 12, 45),
      },
    });
    const seed = vi.mocked(api.department.seed);
    const brief = vi.mocked(api.department.brief);
    const { store } = renderWithStore(<LiveEverydayShell dashboardFirst />, {
      messages: [],
      approvals: [],
    });

    await act(async () => {
      await store.bootstrap();
    });

    await waitFor(() =>
      expect(record).toHaveBeenCalledWith({
        stage: "agent_result",
        target: "acme.com",
        finding: "your hero buries the offer below the fold.",
        artifactTitle: "site-read receipt",
        artifactSummary: "hero rewrite + launch-week post plan",
        receipt: "team mission recorded",
      }),
    );
    expect(seed).toHaveBeenCalledWith("w1", { welcomeTasks: true });
    expect(brief).toHaveBeenCalledWith("w1", {
      lead: "scout",
      goal:
        "Use the first-run site read for acme.com. Finding: your hero buries the offer below the fold. " +
        "Turn it into the next useful marketing move, keep send/spend gated, and leave receipts.",
    });
    expect(window.sessionStorage.getItem(FIRST_RUN_RECEIPT_KEY)).toBeNull();
    expect((await screen.findAllByText("team mission recorded")).length).toBeGreaterThan(0);
  });

  it("keeps the public first-run handoff pending if real team activation fails", async () => {
    const pending = {
      stage: "agent_result",
      target: "acme.com",
      finding: "your hero buries the offer below the fold.",
      artifactTitle: "site-read receipt",
      artifactSummary: "hero rewrite + launch-week post plan",
      receipt: "team mission recorded",
    };
    window.sessionStorage.setItem(FIRST_RUN_RECEIPT_KEY, JSON.stringify(pending));
    vi.mocked(api.recordFirstRunReceipt).mockResolvedValue({
      firstRun: {
        ...pending,
        stage: "agent_result",
        recordedAtMs: Date.UTC(2026, 5, 26, 12, 45),
      },
    });
    vi.mocked(api.department.brief).mockRejectedValue(new Error("agent runtime not connected"));
    const { store } = renderWithStore(<LiveEverydayShell dashboardFirst />, {
      messages: [],
      approvals: [],
    });

    await act(async () => {
      await store.bootstrap();
    });

    await waitFor(() => expect(api.department.seed).toHaveBeenCalledWith("w1", { welcomeTasks: true }));
    await waitFor(() => expect(api.department.brief).toHaveBeenCalled());
    expect(JSON.parse(window.sessionStorage.getItem(FIRST_RUN_RECEIPT_KEY) ?? "{}")).toMatchObject(
      pending,
    );
  });
});
