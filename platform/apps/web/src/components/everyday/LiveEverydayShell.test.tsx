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
    expect(screen.queryByText(/Codex/i)).not.toBeInTheDocument();
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
