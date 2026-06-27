import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CONSOLE } from "../brand.js";
import { PolicyControlCenter } from "./PolicyControlCenter.js";

describe("PolicyControlCenter (#1291)", () => {
  it("renders policy simulation outcomes with rollback or undo status", () => {
    render(
      <PolicyControlCenter
        killSwitchOn={false}
        maintenanceOn={false}
        pendingExternalActions={2}
        loggedDecisions={7}
        onToggleKillSwitch={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: CONSOLE.policy.title })).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.policy.pendingLabel).closest("div")).toHaveTextContent("2");
    expect(screen.getByText(CONSOLE.policy.loggedLabel).closest("div")).toHaveTextContent("7");

    for (const row of CONSOLE.policy.policyRows) {
      const item = screen.getByText(row.action).closest("li")!;
      expect(within(item).getByText(CONSOLE.policy.outcomes[row.outcome])).toBeInTheDocument();
      expect(within(item).getByText(row.rollback)).toBeInTheDocument();
    }
  });

  it("uses the break-glass button to pause and resume the workspace kill switch", async () => {
    const onToggleKillSwitch = vi.fn();
    const { rerender } = render(
      <PolicyControlCenter
        killSwitchOn={false}
        maintenanceOn={false}
        pendingExternalActions={0}
        loggedDecisions={0}
        onToggleKillSwitch={onToggleKillSwitch}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: CONSOLE.policy.engage }));
    expect(onToggleKillSwitch).toHaveBeenCalledWith(true);

    rerender(
      <PolicyControlCenter
        killSwitchOn
        maintenanceOn
        pendingExternalActions={0}
        loggedDecisions={0}
        onToggleKillSwitch={onToggleKillSwitch}
      />,
    );

    expect(screen.getByText(CONSOLE.policy.breakGlassOn)).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.policy.maintenanceOn)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: CONSOLE.policy.resume }));
    expect(onToggleKillSwitch).toHaveBeenCalledWith(false);
  });

  it("submits an arbitrary action to the backend dry-run simulator", async () => {
    const user = userEvent.setup();
    const onSimulatePolicy = vi.fn(async () => ({
      actionType: "external.send",
      amount: 250,
      outcome: "queues_for_approval" as const,
      reason: "amount 250 exceeds auto-approve limit 100",
      rollbackStatus: "Undo depends on the connected provider.",
    }));

    render(
      <PolicyControlCenter
        killSwitchOn={false}
        maintenanceOn={false}
        pendingExternalActions={0}
        loggedDecisions={0}
        onToggleKillSwitch={() => {}}
        onSimulatePolicy={onSimulatePolicy}
      />,
    );

    await user.clear(screen.getByLabelText("Action type to simulate"));
    await user.type(screen.getByLabelText("Action type to simulate"), "external.send");
    await user.type(screen.getByLabelText("Amount to simulate"), "250");
    await user.click(screen.getByRole("button", { name: CONSOLE.policy.simulate }));

    expect(onSimulatePolicy).toHaveBeenCalledWith({ actionType: "external.send", amount: 250 });
    const result = (await screen.findByText("amount 250 exceeds auto-approve limit 100")).closest("article")!;
    expect(within(result).getByText(CONSOLE.policy.outcomes.approval)).toBeInTheDocument();
    expect(within(result).getByText("Undo depends on the connected provider.")).toBeInTheDocument();
  });
});
