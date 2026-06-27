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
});
