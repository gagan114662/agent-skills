import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectHealthChip } from "./ConnectHealthChip.js";

/**
 * #365 — the connection-health chip. Connected is a quiet, non-interactive confirmation; not-connected and
 * expired are buttons that route the owner to Connect Claude (the one action that unlocks real agent runs).
 */
describe("ConnectHealthChip (#365)", () => {
  it("renders nothing while health is loading (null) — no flash of a wrong state", () => {
    const { container } = render(<ConnectHealthChip health={null} onConnect={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a quiet, non-button confirmation when connected", () => {
    render(<ConnectHealthChip health={{ state: "connected", reason: null }} onConnect={() => {}} />);
    expect(screen.getByText(/claude connected/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull(); // nothing to do → not actionable
  });

  it("shows an actionable button that routes to Connect when not connected", () => {
    const onConnect = vi.fn();
    render(<ConnectHealthChip health={{ state: "not_connected", reason: "connect" }} onConnect={onConnect} />);
    const btn = screen.getByRole("button", { name: /claude connection/i });
    fireEvent.click(btn);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("shows a reconnect button when the token expired", () => {
    const onConnect = vi.fn();
    render(<ConnectHealthChip health={{ state: "expired", reason: "stopped working" }} onConnect={onConnect} />);
    const btn = screen.getByRole("button");
    expect(btn.textContent).toMatch(/reconnect/i);
    fireEvent.click(btn);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});
