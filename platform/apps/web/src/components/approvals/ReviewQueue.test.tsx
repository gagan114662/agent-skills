import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewQueue } from "./ReviewQueue.js";
import { renderApprovals } from "../../test/approvals-render.js";
import { makeRequest } from "../../test/approvals-fixtures.js";

describe("ReviewQueue", () => {
  it("renders a pending request with its summary, action, amount and requester", async () => {
    await renderApprovals(<ReviewQueue />, {
      pending: [makeRequest({ id: "r1", summary: "Send wire to ops", amount: 250 })],
    });
    expect(await screen.findByText("Send wire to ops")).toBeInTheDocument();
    expect(screen.getByText("Outbound send")).toBeInTheDocument();
    expect(screen.getByText(/wire \$250/)).toBeInTheDocument();
    expect(screen.getByText(/Send this message to ops@example\.com outside the workspace/)).toBeInTheDocument();
    expect(screen.getByText("$250")).toBeInTheDocument();
    expect(screen.getByText("by Atlas")).toBeInTheDocument();
  });

  it("shows Approve/Reject to a human reviewer who is not the requester", async () => {
    await renderApprovals(<ReviewQueue />, { pending: [makeRequest({ id: "r1" })] }, );
    expect(await screen.findByRole("button", { name: /Approve request:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reject request:/ })).toBeInTheDocument();
  });

  it("hides decision controls from agents (humans-only, mirrors server requireHuman)", async () => {
    await renderApprovals(<ReviewQueue />, { pending: [makeRequest({ id: "r1" })], as: "agent" });
    await screen.findByText(/Send external message/);
    expect(screen.queryByRole("button", { name: /Approve request:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reject request:/ })).not.toBeInTheDocument();
  });

  it("hides Approve on the caller's own request (self-approval guard)", async () => {
    await renderApprovals(<ReviewQueue />, {
      pending: [makeRequest({ id: "r1", requesterMemberId: "me1" })],
      memberId: "me1",
    });
    await screen.findByText(/Send external message/);
    expect(screen.queryByRole("button", { name: /Approve request:/ })).not.toBeInTheDocument();
  });

  it("requires a reason to reject, then removes the decided row", async () => {
    const user = userEvent.setup();
    const { approvals } = await renderApprovals(<ReviewQueue />, {
      pending: [makeRequest({ id: "r1", summary: "Risky send" })],
    });
    await screen.findByText("Risky send");

    await user.click(screen.getByRole("button", { name: /Reject request: Risky send/ }));
    // Empty reason → confirm is disabled.
    const confirm = screen.getByRole("button", { name: /Confirm rejection for request: Risky send/ });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText("Rejection reason"), "not authorized");
    expect(confirm).toBeEnabled();

    approvals.setPending([]); // server no longer returns it after the decision
    await user.click(confirm);

    expect(approvals.reject).toHaveBeenCalledWith("r1", "not authorized");
    await waitFor(() => expect(screen.queryByText("Risky send")).not.toBeInTheDocument());
  });

  it("approving calls the backend and reconciles the queue", async () => {
    const user = userEvent.setup();
    const { approvals } = await renderApprovals(<ReviewQueue />, {
      pending: [makeRequest({ id: "r1", summary: "Approve me" })],
    });
    await screen.findByText("Approve me");
    approvals.setPending([]);
    await user.click(screen.getByRole("button", { name: /Approve request: Approve me/ }));
    expect(approvals.approve).toHaveBeenCalledWith("r1", undefined);
    await waitFor(() => expect(screen.queryByText("Approve me")).not.toBeInTheDocument());
  });

  it("switches status tabs and re-queries the server", async () => {
    const user = userEvent.setup();
    const { approvals } = await renderApprovals(<ReviewQueue />, {
      pending: [makeRequest({ id: "r1", summary: "pending one" })],
      executed: [makeRequest({ id: "e1", summary: "executed one", status: "executed" })],
    });
    await screen.findByText("pending one");
    await user.click(screen.getByRole("tab", { name: /Executed/ }));
    expect(approvals.list).toHaveBeenCalledWith("w1", "executed");
    expect(await screen.findByText("executed one")).toBeInTheDocument();
  });

  it("moves status tabs with arrow keys and exposes the active panel", async () => {
    const user = userEvent.setup();
    const { approvals } = await renderApprovals(<ReviewQueue />, {
      pending: [makeRequest({ id: "r1", summary: "pending one" })],
      executed: [makeRequest({ id: "e1", summary: "executed one", status: "executed" })],
    });
    await screen.findByText("pending one");

    const pending = screen.getByRole("tab", { name: /Pending/ });
    pending.focus();
    await user.keyboard("{ArrowRight}");

    const executed = screen.getByRole("tab", { name: "Executed" });
    expect(executed).toHaveFocus();
    expect(executed).toHaveAttribute("aria-selected", "true");
    expect(approvals.list).toHaveBeenCalledWith("w1", "executed");
    expect(await screen.findByRole("tabpanel", { name: "Executed" })).toBeInTheDocument();
  });
});
