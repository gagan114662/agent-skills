import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalsPanel } from "./ApprovalsPanel.js";
import { renderApprovals } from "../../test/approvals-render.js";
import { makePolicy, makeRequest } from "../../test/approvals-fixtures.js";

describe("ApprovalsPanel", () => {
  it("loads the queue on mount and shows the pending count badge", async () => {
    await renderApprovals(<ApprovalsPanel />, {
      pending: [makeRequest({ id: "r1", summary: "Needs review" }), makeRequest({ id: "r2" })],
    });
    expect(await screen.findByText("Needs review")).toBeInTheDocument();
    // pending count badge (2) appears on the Queue tab (and the Pending status tab)
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
  });

  it("switches to the Policies view for a human", async () => {
    const user = userEvent.setup();
    await renderApprovals(<ApprovalsPanel />, {
      pending: [makeRequest({ id: "r1" })],
      policies: [makePolicy({ id: "p1", actionType: "external.send" })],
    });
    await screen.findByText(/Send external message/);
    await user.click(screen.getByRole("button", { name: "Policies" }));
    expect(await screen.findByText("Approval policies")).toBeInTheDocument();
    expect(screen.getByText("requires approval")).toBeInTheDocument(); // the rule row
  });

  it("does not offer the Policies view to agents", async () => {
    await renderApprovals(<ApprovalsPanel />, { pending: [makeRequest({ id: "r1" })], as: "agent" });
    await screen.findByText(/Send external message/);
    expect(screen.queryByRole("button", { name: "Policies" })).not.toBeInTheDocument();
  });

  it("opens a request's detail (audit timeline) from a queue row", async () => {
    const user = userEvent.setup();
    await renderApprovals(<ApprovalsPanel />, {
      pending: [makeRequest({ id: "r1", summary: "Open me" })],
      detail: makeRequest({ id: "r1", summary: "Open me" }),
      events: [
        { id: "ev1", requestId: "r1", type: "requested", actorMemberId: "ag1", detail: {}, createdAt: "2026-06-08T11:00:00Z" },
      ],
    });
    await user.click(await screen.findByRole("button", { name: "Open request: Open me" }));
    expect(await screen.findByRole("dialog", { name: "Approval request detail" })).toBeInTheDocument();
    expect(screen.getByText("Audit trail")).toBeInTheDocument();
    expect(screen.getByText("Requested")).toBeInTheDocument();
  });

  it("refreshes the pending queue live on an approval notification", async () => {
    const { fire, approvals } = await renderApprovals(<ApprovalsPanel />, {
      pending: [makeRequest({ id: "r1", summary: "first" })],
    });
    await screen.findByText("first");
    approvals.setPending([makeRequest({ id: "r1", summary: "first" }), makeRequest({ id: "r2", summary: "second (live)" })]);
    fire({
      type: "notification",
      notification: {
        id: "n1", type: "approval", recipientMemberId: "me1", actorMemberId: "ag1",
        channelId: null, messageId: null, taskId: null, excerpt: "Approval needed", createdAt: "2026-06-08T12:00:00Z",
      },
    });
    expect(await screen.findByText("second (live)")).toBeInTheDocument();
  });
});
