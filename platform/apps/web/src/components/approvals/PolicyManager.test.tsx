import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PolicyManager } from "./PolicyManager.js";
import { renderApprovals } from "../../test/approvals-render.js";
import { makePolicy } from "../../test/approvals-fixtures.js";

describe("PolicyManager", () => {
  it("lists existing policy rules with their threshold", async () => {
    const { store } = await renderApprovals(<PolicyManager />, {
      policies: [makePolicy({ id: "p1", actionType: "external.send", requireApproval: true, maxAutoAmount: 100 })],
    });
    await store.loadPolicies();
    expect(await screen.findByText(/requires approval over \$100/)).toBeInTheDocument();
    // action name also appears as a <select> option, so there is more than one
    expect(screen.getAllByText("external.send").length).toBeGreaterThan(0);
  });

  it("lets a human add a rule with a spend threshold", async () => {
    const user = userEvent.setup();
    const { store, approvals } = await renderApprovals(<PolicyManager />, { policies: [] });
    await store.loadPolicies();

    await user.type(screen.getByLabelText("Spend threshold"), "100");
    approvals.setPolicies([makePolicy({ id: "p2", actionType: "external.send", maxAutoAmount: 100 })]);
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    expect(approvals.upsertPolicy).toHaveBeenCalledWith("w1", {
      actionType: "external.send",
      requireApproval: true,
      maxAutoAmount: 100,
    });
    expect(await screen.findByText(/requires approval over \$100/)).toBeInTheDocument();
  });

  it("lets a human remove a rule", async () => {
    const user = userEvent.setup();
    const { store, approvals } = await renderApprovals(<PolicyManager />, {
      policies: [makePolicy({ id: "p1", actionType: "external.send" })],
    });
    await store.loadPolicies();
    await screen.findByText("requires approval");

    approvals.setPolicies([]);
    await user.click(screen.getByRole("button", { name: /Remove policy for external.send/ }));
    expect(approvals.deletePolicy).toHaveBeenCalledWith("w1", "p1");
    await waitFor(() => expect(screen.queryByText("requires approval")).not.toBeInTheDocument());
  });

  it("hides the editor from agents (humans-only)", async () => {
    const { store } = await renderApprovals(<PolicyManager />, {
      policies: [makePolicy({ id: "p1", actionType: "external.send" })],
      as: "agent",
    });
    await store.loadPolicies();
    await screen.findByText("external.send");
    expect(screen.queryByRole("button", { name: "Add rule" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove policy/ })).not.toBeInTheDocument();
    expect(screen.getByText("Only human members can manage policies.")).toBeInTheDocument();
  });
});
