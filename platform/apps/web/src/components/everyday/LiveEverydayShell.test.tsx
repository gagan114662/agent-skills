import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ApprovalRequestDto } from "@reload/shared";
import { LiveEverydayShell } from "./LiveEverydayShell.js";
import { EVERYDAY } from "../../brand.js";
import { api } from "../../api/client.js";
import { makeMessage, renderWithStore } from "../../test/utils.js";

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders signed-in workspace state instead of the Northwind/Dana seed", async () => {
    const { store } = renderWithStore(<LiveEverydayShell />, {
      messages: [
        makeMessage({ id: "m-live", authorMemberId: "ag1", body: "Scout found a real Search Console issue." }),
      ],
      approvals: [approval()],
    });

    await act(async () => {
      await store.bootstrap();
    });

    expect((await screen.findAllByText("Scout found a real Search Console issue.")).length).toBeGreaterThan(0);
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
    vi.spyOn(api, "getConnections").mockResolvedValue({ connections: [], canManageInternal: false });
    vi.spyOn(api, "getCodexStatus").mockResolvedValue({
      connected: false,
      reason: "Codex-backed team runs are not connected for this session.",
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
});
