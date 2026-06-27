import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ApprovalRequestDto } from "@reload/shared";
import { LiveEverydayShell } from "./LiveEverydayShell.js";
import { EVERYDAY } from "../../brand.js";
import { api } from "../../api/client.js";
import { makeMessage, renderWithStore } from "../../test/utils.js";
import { FIRST_RUN_RECEIPT_KEY } from "../onboarding/first-run-receipt.js";

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

describe("LiveEverydayShell (#1181)", () => {
  beforeEach(() => {
    vi.spyOn(api, "getFirstRunReceipt").mockResolvedValue({ firstRun: null });
    vi.spyOn(api, "recordFirstRunReceipt").mockResolvedValue({ firstRun: null });
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
    expect(await screen.findByText("Send follow-up to Morgan")).toBeInTheDocument();
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
    await waitFor(() => expect(screen.queryByText(/Northwind/i)).not.toBeInTheDocument());
  });

  it("blocks iMessage room launch before posting when the signed-in team engine is not connected", async () => {
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
    const postMessage = vi.spyOn(api, "postMessage");
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
    expect(postMessage).not.toHaveBeenCalled();
    expect(launchTeamRun).not.toHaveBeenCalled();
  });

  it("blocks room launch when iMessage relay has not produced a receipt (#1283)", async () => {
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
      await screen.findByText("iMessage relay is not configured for this workspace yet."),
    ).toBeInTheDocument();
    expect(launchTeamRun).not.toHaveBeenCalled();
  });

  it("blocks room launch when iMessage relay is only dry-run (#1283)", async () => {
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
      await screen.findByText("iMessage relay is still in dry-run mode; no real Messages room was started."),
    ).toBeInTheDocument();
    expect(launchTeamRun).not.toHaveBeenCalled();
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
    expect(screen.getByText(/gagan@example.com/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: EVERYDAY.connectors.imessage.test }));

    await waitFor(() => expect(test).toHaveBeenCalled());
    expect(await screen.findByText(EVERYDAY.connectors.imessage.verified)).toBeInTheDocument();
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
        active: true,
      },
    });
    const { store } = renderWithStore(<LiveEverydayShell />, { messages: [], approvals: [] });

    await act(async () => {
      await store.bootstrap();
    });

    expect(await screen.findByText(EVERYDAY.connectors.imessage.blocked)).toBeInTheDocument();
    expect(screen.getByText(/recipient verified; relay is dry-run/i)).toBeInTheDocument();
    expect(screen.getByText(/Mac relay host active: Gagans-MacBook-Pro/i)).toBeInTheDocument();
    expect(screen.getByText(/last iMessage relay failed: Apple Messages send failed/i)).toBeInTheDocument();
    expect(screen.queryByText(EVERYDAY.connectors.connected)).not.toBeInTheDocument();
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
    expect(screen.getAllByText("site-read receipt").length).toBeGreaterThan(0);
    expect(screen.getAllByText("send/spend gates active").length).toBeGreaterThan(0);
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
