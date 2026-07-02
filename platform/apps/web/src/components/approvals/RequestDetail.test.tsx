import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RequestDetail } from "./RequestDetail.js";
import { renderApprovals } from "../../test/approvals-render.js";
import { makeRequest } from "../../test/approvals-fixtures.js";

const EVENTS = [
  { id: "ev1", requestId: "r1", type: "requested" as const, actorMemberId: "ag1", detail: { reason: "policy: external.send" }, createdAt: "2026-06-08T11:00:00Z" },
  { id: "ev2", requestId: "r1", type: "rejected" as const, actorMemberId: "me1", detail: { reason: "not authorized" }, createdAt: "2026-06-08T11:05:00Z" },
];

describe("RequestDetail", () => {
  it("renders nothing until a request is opened", async () => {
    const { container } = await renderApprovals(<RequestDetail />, {});
    expect(container.querySelector(".request-detail")).toBeNull();
  });

  it("renders the request facts and its append-only audit timeline in order", async () => {
    const { store } = await renderApprovals(<RequestDetail />, {
      detail: makeRequest({ id: "r1", summary: "Wire $250 to ops", status: "rejected", reason: "not authorized", decidedByMemberId: "me1" }),
      events: EVENTS,
    });
    await act(async () => {
      await store.openRequest("r1");
    });

    expect(await screen.findByText("Wire $250 to ops")).toBeInTheDocument();
    expect(screen.getByText("rejected")).toBeInTheDocument();
    // facts
    expect(screen.getByText("Outbound send")).toBeInTheDocument();
    expect(screen.getAllByText("Ada").length).toBeGreaterThan(0); // decided by me1 → Ada

    expect(screen.getByRole("region", { name: "Exactly what will ship" })).toHaveTextContent("wire $250");
    expect(screen.getByRole("region", { name: "Approval decision" })).toHaveTextContent(/What changes/);
    expect(screen.getByText(/Send receipt is saved/)).toBeInTheDocument();
    expect(screen.getByText(/Money approval: \$250/)).toBeInTheDocument();

    // timeline, in order
    const types = screen.getAllByText(/^(Requested|Rejected)$/).map((n) => n.textContent);
    expect(types).toEqual(["Requested", "Rejected"]);
    // the reason appears both as a fact and in the timeline detail
    expect(screen.getAllByText("not authorized").length).toBeGreaterThan(0);
  });

  it("shows rollback metadata and provider link for executed approvals", async () => {
    const { store } = await renderApprovals(<RequestDetail />, {
      detail: makeRequest({
        id: "r1",
        summary: "Publish landing page",
        status: "executed",
        result: {
          published: true,
          rollback: {
            label: "Provider rollback",
            status: "Reversible through the linked provider undo/rollback action.",
            url: "https://provider.example/rollback/abc",
          },
        },
      }),
      events: EVENTS,
    });
    await act(async () => {
      await store.openRequest("r1");
    });

    expect(await screen.findByText("Rollback")).toBeInTheDocument();
    expect(screen.getByText("Provider rollback")).toBeInTheDocument();
    expect(screen.getByText("Reversible through the linked provider undo/rollback action.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open rollback" })).toHaveAttribute(
      "href",
      "https://provider.example/rollback/abc",
    );
  });

  it("closes via the close control", async () => {
    const { store, container } = await renderApprovals(<RequestDetail />, {
      detail: makeRequest({ id: "r1" }),
      events: EVENTS,
    });
    await act(async () => {
      await store.openRequest("r1");
    });
    await screen.findByRole("dialog", { name: /Send external message/ });
    act(() => {
      store.closeRequest();
    });
    await waitFor(() => expect(container.querySelector(".request-detail")).toBeNull());
  });

  it("lets the reviewer approve with inline edits or request changes from the one-screen detail pane", async () => {
    const user = userEvent.setup();
    const { store, approvals } = await renderApprovals(<RequestDetail />, {
      detail: makeRequest({
        id: "r1",
        summary: "Send launch note",
        payload: {
          to: "lead@example.com",
          subject: "Quick launch note",
          body: "hello from ipop",
          rationale: "Scout found a warm lead",
        },
      }),
      events: EVENTS,
    });
    await act(async () => {
      await store.openRequest("r1");
    });

    expect(await screen.findByRole("region", { name: "Exactly what will ship" })).toHaveTextContent(
      "hello from ipop",
    );
    expect(screen.getByText("Scout found a warm lead")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Request changes for request: Send launch note/ }));
    const sendChanges = screen.getByRole("button", { name: /Send request changes for request: Send launch note/ });
    expect(sendChanges).toBeDisabled();
    await user.type(screen.getByLabelText("Request changes note"), "make it shorter");
    expect(sendChanges).toBeEnabled();
    await user.click(sendChanges);
    expect(approvals.requestChanges).toHaveBeenCalledWith("r1", "make it shorter");

    await user.clear(screen.getByLabelText("Edit message"));
    await user.type(screen.getByLabelText("Edit message"), "short hello from ipop");
    await user.click(screen.getByRole("button", { name: /Approve request: Send launch note/ }));
    expect(approvals.approve).toHaveBeenCalledWith("r1", undefined, {
      field: "body",
      value: "short hello from ipop",
    });
  });

  it("renders channel-native draft sets side by side and approves the edited packet", async () => {
    const user = userEvent.setup();
    const { store, approvals } = await renderApprovals(<RequestDetail />, {
      detail: makeRequest({
        id: "r1",
        actionType: "agent.deliverable",
        amount: null,
        summary: "Deliverable ready for review: launch pack",
        payload: {
          channelId: "c1",
          task: "Launch ipop to founders",
          artifact: {
            kind: "draft_set",
            schemaVersion: 1,
            drafts: [
              {
                format: "email",
                title: "Founder launch email",
                fields: {
                  subject: "Your marketing team is waiting",
                  preheader: "Scout, Quill, Lens, Echo, and Bid are already in the room.",
                  body: "Give the team a target and review the draft before it ships.",
                  cta: "Start the room",
                  plainTextAlt: "Start the room with ipop.",
                },
                citations: ["homepage proof"],
              },
              {
                format: "x_thread",
                title: "Launch thread",
                fields: {
                  tweets: [
                    "Your marketing team should live where you already message.",
                    "ipop turns Scout, Quill, Lens, Echo, and Bid into one room.",
                  ],
                },
                citations: ["homepage proof"],
              },
            ],
          },
        },
      }),
      events: EVENTS,
    });
    await act(async () => {
      await store.openRequest("r1");
    });

    expect(await screen.findByText("Email")).toBeInTheDocument();
    expect(screen.getByText("X thread")).toBeInTheDocument();
    expect(screen.getByText("Your marketing team is waiting")).toBeInTheDocument();
    expect(screen.getAllByText(/ipop turns Scout, Quill, Lens, Echo, and Bid into one room/).length).toBeGreaterThan(0);

    await user.clear(screen.getByLabelText("Edit draft"));
    await user.type(screen.getByLabelText("Edit draft"), "approved multi-channel packet");
    await user.click(screen.getByRole("button", { name: /Approve request: Deliverable ready for review/ }));

    expect(approvals.approve).toHaveBeenCalledWith("r1", undefined, {
      field: "draft",
      value: "approved multi-channel packet",
    });
  });
});
