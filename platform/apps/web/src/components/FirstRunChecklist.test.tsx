import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FirstRunChecklist } from "./FirstRunChecklist.js";
import { deriveFirstRunChecklist } from "../lib/firstrun-checklist.js";
import { CONSOLE } from "../brand.js";

const steps = (over = {}) =>
  deriveFirstRunChecklist({ brandSet: false, hasConnection: false, agentRan: false, resultApproved: false, ...over });

describe("FirstRunChecklist (#479)", () => {
  it("shows all four setup steps with progress", () => {
    render(<FirstRunChecklist steps={steps()} onAction={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText(CONSOLE.firstRunChecklist.steps.brand.label)).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.firstRunChecklist.steps.connect.label)).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.firstRunChecklist.steps.run.label)).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.firstRunChecklist.steps.approve.label)).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.firstRunChecklist.progress(0, 4))).toBeInTheDocument();
  });

  it("a done step shows a check and drops its CTA", () => {
    render(<FirstRunChecklist steps={steps({ brandSet: true })} onAction={vi.fn()} onDismiss={vi.fn()} />);
    // The brand step is done → no "Set brand" button; the others still have CTAs.
    expect(screen.queryByRole("button", { name: CONSOLE.firstRunChecklist.steps.brand.cta })).toBeNull();
    expect(screen.getByRole("button", { name: CONSOLE.firstRunChecklist.steps.connect.cta })).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.firstRunChecklist.progress(1, 4))).toBeInTheDocument();
  });

  it("routes an outstanding step's CTA to onAction with its key", async () => {
    const onAction = vi.fn();
    render(<FirstRunChecklist steps={steps()} onAction={onAction} onDismiss={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: CONSOLE.firstRunChecklist.steps.approve.cta }));
    expect(onAction).toHaveBeenCalledWith("approve");
  });

  it("dismisses", async () => {
    const onDismiss = vi.fn();
    render(<FirstRunChecklist steps={steps()} onAction={vi.fn()} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: CONSOLE.firstRunChecklist.dismiss }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
