import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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
    await store.openRequest("r1");

    expect(await screen.findByText("Wire $250 to ops")).toBeInTheDocument();
    expect(screen.getByText("rejected")).toBeInTheDocument();
    // facts
    expect(screen.getByText("external.send")).toBeInTheDocument();
    expect(screen.getAllByText("Ada").length).toBeGreaterThan(0); // decided by me1 → Ada

    // timeline, in order
    const types = screen.getAllByText(/^(Requested|Rejected)$/).map((n) => n.textContent);
    expect(types).toEqual(["Requested", "Rejected"]);
    // the reason appears both as a fact and in the timeline detail
    expect(screen.getAllByText("not authorized").length).toBeGreaterThan(0);
  });

  it("closes via the close control", async () => {
    const { store, container } = await renderApprovals(<RequestDetail />, {
      detail: makeRequest({ id: "r1" }),
      events: EVENTS,
    });
    await store.openRequest("r1");
    await screen.findByRole("dialog", { name: "Approval request detail" });
    store.closeRequest();
    await waitFor(() => expect(container.querySelector(".request-detail")).toBeNull());
  });
});
