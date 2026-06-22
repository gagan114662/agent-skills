/**
 * #729 floating command dock. Proves it surfaces the quick actions + theme toggle, that the toggle flips the
 * live palette, and that — being purely additive — it degrades to just the theme button when no host handlers
 * are wired. Uses fireEvent (synchronous) so the assertions don't depend on async user-event timing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RELOAD_DARK_THEME } from "../theme.js";
import { CommandDock } from "./CommandDock.js";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

describe("CommandDock", () => {
  it("renders the quick actions and the theme toggle", () => {
    render(<CommandDock onOpenApprovals={() => {}} onOpenSettings={() => {}} />);
    expect(screen.getByRole("toolbar", { name: /quick actions/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open approvals/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open workspace settings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /switch to dark theme/i })).toBeInTheDocument();
  });

  it("flips the live palette when the theme button is clicked (persistence covered in theme-toggle.test)", () => {
    render(<CommandDock />);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /switch to dark theme/i }));
    expect(document.documentElement.getAttribute("data-theme")).toBe(RELOAD_DARK_THEME);

    // The label now offers the reverse direction, and a second click returns to light.
    fireEvent.click(screen.getByRole("button", { name: /switch to light theme/i }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("invokes the host handlers for approvals and settings", () => {
    const onOpenApprovals = vi.fn();
    const onOpenSettings = vi.fn();
    render(<CommandDock onOpenApprovals={onOpenApprovals} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: /open approvals/i }));
    fireEvent.click(screen.getByRole("button", { name: /open workspace settings/i }));
    expect(onOpenApprovals).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("shows a waiting-count badge only when there are pending approvals", () => {
    const { rerender } = render(<CommandDock onOpenApprovals={() => {}} pendingCount={0} />);
    expect(screen.queryByText(/^[0-9]/)).toBeNull();
    rerender(<CommandDock onOpenApprovals={() => {}} pendingCount={3} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    rerender(<CommandDock onOpenApprovals={() => {}} pendingCount={42} />);
    expect(screen.getByText("9+")).toBeInTheDocument();
  });

  it("is additive: with no handlers it still renders just the theme toggle", () => {
    render(<CommandDock />);
    expect(screen.getByRole("button", { name: /switch to dark theme/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open approvals/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /open workspace settings/i })).toBeNull();
  });
});
