import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SlackConnect } from "./SlackConnect.js";

/**
 * #170 — Connect Slack settings panel (presentational). Lets the owner connect their Slack app; both
 * secret fields are masked and the stored secrets are never rendered back.
 */
describe("SlackConnect (#170)", () => {
  it("shows a not-connected state with two masked secret fields", () => {
    render(<SlackConnect status={{ connected: false, fingerprint: null }} onConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    expect((screen.getByLabelText(/bot token/i) as HTMLInputElement).type).toBe("password");
    expect((screen.getByLabelText(/signing secret/i) as HTMLInputElement).type).toBe("password");
  });

  it("disables Connect until BOTH secrets are entered", () => {
    render(<SlackConnect status={{ connected: false, fingerprint: null }} onConnect={() => {}} onDisconnect={() => {}} />);
    const button = () => screen.getByRole("button", { name: /connect/i });
    expect(button()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "xoxb-1" } });
    expect(button()).toBeDisabled(); // still missing the signing secret
    fireEvent.change(screen.getByLabelText(/signing secret/i), { target: { value: "sek" } });
    expect(button()).not.toBeDisabled();
  });

  it("calls onConnect with both pasted secrets", () => {
    const onConnect = vi.fn();
    render(<SlackConnect status={{ connected: false, fingerprint: null }} onConnect={onConnect} onDisconnect={() => {}} />);
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "xoxb-abc" } });
    fireEvent.change(screen.getByLabelText(/signing secret/i), { target: { value: "sign-xyz" } });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    expect(onConnect).toHaveBeenCalledWith({ botToken: "xoxb-abc", signingSecret: "sign-xyz" });
  });

  it("shows a connected state with the fingerprint and a disconnect action", () => {
    const onDisconnect = vi.fn();
    render(
      <SlackConnect
        status={{ connected: true, fingerprint: "abc123def456" }}
        onConnect={() => {}}
        onDisconnect={onDisconnect}
      />,
    );
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
    expect(screen.getByText(/abc123def456/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalled();
  });
});
