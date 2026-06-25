import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FirstRunChecklist } from "./FirstRunChecklist.js";
import { deriveFirstRunChecklist } from "../lib/firstrun-checklist.js";
import { CONSOLE } from "../brand.js";

const steps = (over = {}) =>
  deriveFirstRunChecklist({
    targetSet: false,
    brandSet: false,
    claudeConnected: false,
    hasConnection: false,
    agentRan: false,
    resultApproved: false,
    ...over,
  });

describe("FirstRunChecklist (#479)", () => {
  it("shows all six setup steps with progress", () => {
    render(<FirstRunChecklist steps={steps()} collapsed={false} onAction={vi.fn()} onToggleCollapse={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText(CONSOLE.firstRunChecklist.steps.target.label)).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.firstRunChecklist.steps.brand.label)).toBeInTheDocument();
    expect(screen.getAllByText(CONSOLE.firstRunChecklist.steps.claude.label)).toHaveLength(2);
    expect(screen.getByText(CONSOLE.firstRunChecklist.steps.connect.label)).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.firstRunChecklist.steps.run.label)).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.firstRunChecklist.steps.approve.label)).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.firstRunChecklist.progress(0, 6))).toBeInTheDocument();
  });

  it("a done step shows a check and drops its CTA", () => {
    render(<FirstRunChecklist steps={steps({ brandSet: true })} collapsed={false} onAction={vi.fn()} onToggleCollapse={vi.fn()} onDismiss={vi.fn()} />);
    // The brand step is done → no "Set brand" button; the others still have CTAs.
    expect(screen.queryByRole("button", { name: CONSOLE.firstRunChecklist.steps.brand.cta })).toBeNull();
    expect(screen.getByRole("button", { name: CONSOLE.firstRunChecklist.steps.claude.cta })).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.firstRunChecklist.progress(1, 6))).toBeInTheDocument();
  });

  it("keeps the progress counter in sync with the visible completed steps", () => {
    const visibleSteps = steps({ targetSet: true, claudeConnected: true, hasConnection: true, agentRan: true });
    const { container } = render(
      <FirstRunChecklist
        steps={visibleSteps}
        collapsed={false}
        onAction={vi.fn()}
        onToggleCollapse={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(visibleSteps.length);
    expect(container.querySelectorAll(".firstrun__step--done")).toHaveLength(4);
    expect(screen.getByText(CONSOLE.firstRunChecklist.progress(4, visibleSteps.length))).toBeInTheDocument();
  });

  it("routes an outstanding step's CTA to onAction with its key", async () => {
    const onAction = vi.fn();
    render(<FirstRunChecklist steps={steps()} collapsed={false} onAction={onAction} onToggleCollapse={vi.fn()} onDismiss={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: CONSOLE.firstRunChecklist.steps.approve.cta }));
    expect(onAction).toHaveBeenCalledWith("approve");
  });

  it("dismisses", async () => {
    const onDismiss = vi.fn();
    render(<FirstRunChecklist steps={steps()} collapsed={false} onAction={vi.fn()} onToggleCollapse={vi.fn()} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: CONSOLE.firstRunChecklist.dismiss }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // #505: dockable/collapsible so the card never takes over the message area.
  it("collapsed: hides the steps but keeps the docked header bar", () => {
    render(<FirstRunChecklist steps={steps()} collapsed={true} onAction={vi.fn()} onToggleCollapse={vi.fn()} onDismiss={vi.fn()} />);
    // The tall steps list is gone…
    expect(screen.queryByText(CONSOLE.firstRunChecklist.steps.brand.label)).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    // …but the one-line header (title · progress · Hide) still renders.
    expect(screen.getByText(CONSOLE.firstRunChecklist.title)).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.firstRunChecklist.progress(0, 6))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CONSOLE.firstRunChecklist.dismiss })).toBeInTheDocument();
  });

  it("toggles dock state from the chevron control", async () => {
    const onToggleCollapse = vi.fn();
    const { rerender } = render(
      <FirstRunChecklist steps={steps()} collapsed={false} onAction={vi.fn()} onToggleCollapse={onToggleCollapse} onDismiss={vi.fn()} />,
    );
    // Expanded → the control collapses (and advertises expanded state for a11y).
    const collapseBtn = screen.getByRole("button", { name: CONSOLE.firstRunChecklist.collapse });
    expect(collapseBtn).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(collapseBtn);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    // Collapsed → the control expands.
    rerender(<FirstRunChecklist steps={steps()} collapsed={true} onAction={vi.fn()} onToggleCollapse={onToggleCollapse} onDismiss={vi.fn()} />);
    const expandBtn = screen.getByRole("button", { name: CONSOLE.firstRunChecklist.expand });
    expect(expandBtn).toHaveAttribute("aria-expanded", "false");
  });
});
